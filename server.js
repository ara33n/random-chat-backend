import express from "express";
import http from "http";
import cors from "cors";
import axios from "axios";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { Server as IOServer } from "socket.io";
import geoip from "geoip-lite";
import fs from "fs";
import path from "path";
import filter from "leo-profanity";
import mongoose from "mongoose";

// === Existing models ===
import Payment from "./models/Payment.js";
import Message from "./models/Message.js";
import Report from "./models/Report.js";

// === New user model ===
import User from "./models/User.js";

// ---------------- App & DB ----------------
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

mongoose
    .connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/chatapp")
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => console.error("❌ MongoDB connect error:", err));

// ---------------- Env & Constants ----------------
const API_KEY = process.env.NOWPAY_API_KEY || "YYB93M2-WBMM0HH-N17825T-ERPG0QN";
const GOOGLE_CLIENT_ID =
    process.env.GOOGLE_CLIENT_ID ||
    "997739380757-jluek15p8cbm80ut04fibbkl9jr6ofno.apps.googleusercontent.com";
const JWT_SECRET = process.env.JWT_SECRET || "change_me_in_prod";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ---------------- Ban Schema (extended) ----------------
const banSchema = new mongoose.Schema({
    ip: { type: String },
    email: { type: String },
    reason: { type: String, required: true },
    expiry: { type: Date, required: true },
    snapshotBase64: { type: String },
    paymentRequired: { type: Boolean, default: false },
    paymentStatus: { type: String, default: "pending" }, // pending, success, cancelled
    status: { type: String, enum: ["active", "closed"], default: "active" },
    closedAt: { type: Date },
    paymentOrderId: { type: String },
    paymentUrl: { type: String },
    createdAt: { type: Date, default: Date.now },
});
const Ban = mongoose.model("Ban", banSchema);

// ---------------- Helpers ----------------
async function getActiveBan({ ip, email }) {
    // Prefer email if present
    let q = email ? { email, status: "active" } : { ip, status: "active" };
    let ban = await Ban.findOne(q).sort({ createdAt: -1 });
    if (!ban && email && ip) {
        // fallback to IP if email ban not found
        ban = await Ban.findOne({ ip, status: "active" }).sort({
            createdAt: -1,
        });
    }
    if (!ban) return null;

    if (Date.now() > ban.expiry.getTime()) {
        ban.status = "closed";
        ban.closedAt = new Date();
        await ban.save();
        return null;
    }
    return ban;
}

// read version
const pkgPath = path.join(process.cwd(), "package.json");
let appVersion = "1.0.1";
try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw);
    appVersion = parsed.version || appVersion;
} catch {
    console.warn("⚠️ Could not read package.json version, defaulting to 1.0.1");
}

app.use("/snapshots", express.static(path.join(process.cwd(), "snapshots")));

// ---------------- Admin auth (simple header check) ----------------
function adminAuth(req, res, next) {
    const user = req.headers["x-admin-user"];
    const pass = req.headers["x-admin-pass"];
    const token = req.headers["x-admin-token"];

    const ADMIN_USER = process.env.ADMIN_USER || "admin";
    const ADMIN_PASS = process.env.ADMIN_PASS || "Abcd!234";
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

    if (
        (user === ADMIN_USER && pass === ADMIN_PASS) ||
        (token && token === ADMIN_TOKEN)
    ) {
        return next();
    }
    return res.status(403).json({ error: "Unauthorized" });
}

// ---------------- Basic routes ----------------
app.get("/", (req, res) =>
    res.json({ ok: true, message: "Random Chat Signaling Server running." })
);
app.get("/version", (req, res) => res.json({ version: appVersion }));
app.get("/check-outbound-ip", async (_req, res) => {
    try {
        const response = await axios.get("https://ifconfig.me/ip");
        res.json({ outboundIP: response.data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------- Google Auth ----------------
function authOptional(req, _res, next) {
    const raw = req.cookies?.session;
    if (raw) {
        try {
            req.user = jwt.verify(raw, JWT_SECRET);
        } catch {
            req.user = null;
        }
    }
    next();
}

app.post("/auth/google", async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken)
            return res.status(400).json({ error: "idToken required" });

        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload?.email) {
            return res.status(401).json({ error: "Invalid Google token" });
        }

        const googleId = payload.sub;
        const email = payload.email;
        const name = payload.name || "";
        const picture = payload.picture || "";

        // Upsert user
        const now = new Date();
        const user = await User.findOneAndUpdate(
            { googleId },
            {
                $set: { email, name, picture },
                $inc: { loginCount: 1 },
                $setOnInsert: { createdAt: now },
                lastLoginAt: now,
            },
            { upsert: true, new: true }
        );

        const token = jwt.sign(
            { uid: googleId, email, name, picture },
            JWT_SECRET,
            { expiresIn: "7d" }
        );
        res.cookie("session", token, {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });
        res.json({ ok: true, profile: { email, name, picture } });
    } catch (e) {
        console.error("Google auth error:", e);
        res.status(401).json({ error: "Invalid Google token" });
    }
});

app.post("/auth/logout", (_req, res) => {
    res.clearCookie("session", { httpOnly: true, sameSite: "lax" });
    res.json({ ok: true });
});

app.get("/auth/me", authOptional, (req, res) => {
    if (!req.user) return res.json({ ok: false });
    res.json({ ok: true, user: req.user });
});

// ---------------- Payments (as-is) ----------------
app.post("/api/create-payment", async (req, res) => {
    try {
        const { amount, currency } = req.body;
        const response = await axios.post(
            "https://api.nowpayments.io/v1/invoice",
            {
                price_amount: amount,
                price_currency: currency,
                pay_currency: "icx",
                order_id: "order_" + Date.now(),
                order_description: "Payment via NOWPayments",
                ipn_callback_url: "http://localhost:3001/api/payment-webhook",
            },
            {
                headers: {
                    "x-api-key": API_KEY,
                    "Content-Type": "application/json",
                },
            }
        );

        const newPayment = new Payment({
            orderId: response.data.order_id,
            amount: response.data.price_amount,
            currency: response.data.price_currency,
            payCurrency: response.data.pay_currency,
            paymentStatus: response.data.payment_status,
            paymentId: response.data.id,
        });
        await newPayment.save();

        res.json({
            payment_url: response.data.invoice_url,
            orderId: response.data.order_id,
        });
    } catch (error) {
        console.error(
            "Create Invoice Error:",
            error.response?.data || error.message
        );
        res.status(500).json({ error: "Payment creation failed" });
    }
});

app.get("/api/payment-status/:orderId", async (req, res) => {
    try {
        const { orderId } = req.params;
        const payment = await Payment.findOne({ orderId });
        if (!payment)
            return res.status(404).json({ error: "Payment not found" });
        res.json({
            orderId: payment.orderId,
            amount: payment.amount,
            currency: payment.currency,
            payCurrency: payment.payCurrency,
            status: payment.paymentStatus,
            txHash: payment.txHash,
            createdAt: payment.createdAt,
            updatedAt: payment.updatedAt,
        });
    } catch (err) {
        console.error("Status Check Error:", err);
        res.status(500).json({ error: "Failed to fetch status" });
    }
});

// ---------------- Admin: Reports & Bans ----------------
app.get("/admin/reports", adminAuth, async (_req, res) => {
    try {
        const reports = await Report.find().sort({ createdAt: -1 });
        res.json(reports);
    } catch (err) {
        console.error("Admin reports error:", err);
        res.status(500).json({ error: "Failed to fetch reports" });
    }
});

// List users for admin
app.get("/admin/users", adminAuth, async (req, res) => {
    const q = (req.query.q || "").toString().trim();
    const filter = q
        ? { $or: [{ email: new RegExp(q, "i") }, { name: new RegExp(q, "i") }] }
        : {};
    const users = await User.find(filter).sort({ lastLoginAt: -1 }).limit(500);
    res.json(users);
});

// Ban by ip OR email
app.post("/admin/ban-user", adminAuth, async (req, res) => {
    try {
        const { ip, email, durationMs, reason } = req.body;
        if (!ip && !email)
            return res.status(400).json({ error: "ip or email required" });

        const banDuration = Math.max(1, durationMs || 10 * 60 * 1000);
        const expiry = new Date(Date.now() + banDuration);

        const ban = new Ban({
            ip: ip || undefined,
            email: email || undefined,
            reason: reason || "Manual admin ban",
            expiry,
            status: "active",
        });
        await ban.save();

        // Mark related reports as banned (IP-only link available by default)
        if (ip) {
            await Report.updateMany(
                { accusedIp: ip, status: { $ne: "banned" } },
                { status: "banned" }
            );
        }

        res.json({ message: "User banned successfully", ban });
    } catch (err) {
        console.error("Admin ban error:", err);
        res.status(500).json({ error: "Failed to ban user" });
    }
});

// Unban by id OR email OR ip
app.post("/admin/unban-user", adminAuth, async (req, res) => {
    try {
        const { ip, email, banId } = req.body;
        let ban = null;
        if (banId) ban = await Ban.findById(banId);
        if (!ban && email)
            ban = await Ban.findOne({ email, status: "active" }).sort({
                createdAt: -1,
            });
        if (!ban && ip)
            ban = await Ban.findOne({ ip, status: "active" }).sort({
                createdAt: -1,
            });
        if (!ban)
            return res.status(404).json({ error: "Active ban not found" });

        ban.status = "closed";
        ban.closedAt = new Date();
        if (ban.expiry > new Date()) ban.expiry = new Date(Date.now() - 1000);
        await ban.save();

        // Close related reports by ip
        if (ban.ip) {
            await Report.updateMany(
                { accusedIp: ban.ip, status: { $ne: "closed" } },
                { status: "closed" }
            );
        }

        res.json({ message: "User unbanned", ban });
    } catch (err) {
        console.error("Admin unban error:", err);
        res.status(500).json({ error: "Failed to unban user" });
    }
});

// Close report
app.post("/admin/close-report", adminAuth, async (req, res) => {
    try {
        const { reportId } = req.body;
        if (!reportId)
            return res.status(400).json({ error: "reportId required" });
        await Report.findByIdAndUpdate(reportId, { status: "closed" });
        res.json({ message: "Report closed" });
    } catch (err) {
        console.error("Close report error:", err);
        res.status(500).json({ error: "Failed to close report" });
    }
});

// Resolve report
app.post("/admin/resolve-report", adminAuth, async (req, res) => {
    try {
        const { reportId, action } = req.body;
        if (!reportId)
            return res.status(400).json({ error: "reportId required" });
        const update = {
            status:
                String(action).toLowerCase() === "ban" ? "banned" : "reviewed",
        };
        await Report.findByIdAndUpdate(reportId, update);
        res.json({ message: "Report updated", action: update.status });
    } catch (err) {
        console.error("Resolve report error:", err);
        res.status(500).json({ error: "Failed to update report" });
    }
});

// List bans
app.get("/admin/bans", adminAuth, async (req, res) => {
    try {
        const activeOnly = String(req.query.activeOnly || "true") === "true";
        const q = activeOnly ? { status: "active" } : {};
        const bans = await Ban.find(q).sort({ createdAt: -1 });
        res.json(bans);
    } catch (e) {
        console.error("Admin bans list error:", e);
        res.status(500).json({ error: "Failed to fetch bans" });
    }
});

// ---------------- Socket.io ----------------
const server = http.createServer(app);
const io = new IOServer(server, {
    cors: { origin: true, credentials: true, methods: ["GET", "POST"] },
});

// Queues & maps
const queues = { video: [], text: [] };
const partnerOf = new Map();
const modeOf = new Map();
const countryOf = new Map();
const startedAt = new Map();
const topicsOf = new Map();

// profanity
filter.loadDictionary();
filter.add(["sex", "nude", "xxx", "islam"]);

// local temp bans for profanity
const badWordCount = new Map();
const bannedIPs = new Map();

function broadcastOnlineCount() {
    io.emit("online-count", { count: io.sockets.sockets.size });
}

function isTempBanned(ip) {
    const expiry = bannedIPs.get(ip);
    if (!expiry) return false;
    if (Date.now() > expiry) {
        bannedIPs.delete(ip);
        badWordCount.delete(ip);
        return false;
    }
    return true;
}

function safePartner(id) {
    const pid = partnerOf.get(id);
    if (!pid) return null;
    return io.sockets.sockets.get(pid) || null;
}

function enqueue(socket, mode) {
    const list = queues[mode];
    if (!list.includes(socket.id)) list.push(socket.id);
    modeOf.set(socket.id, mode);
}

function dequeue(mode, id) {
    const list = queues[mode];
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
}

function tryMatch(mode) {
    const list = queues[mode];
    while (list.length >= 2) {
        const aId = list.shift();
        const bId = list.shift();
        const a = io.sockets.sockets.get(aId);
        const b = io.sockets.sockets.get(bId);
        if (!a || !b) continue;

        partnerOf.set(aId, bId);
        partnerOf.set(bId, aId);
        startedAt.set(aId, Date.now());
        startedAt.set(bId, Date.now());

        const initiator = Math.random() < 0.5 ? aId : bId;
        const aCountry = countryOf.get(aId) || "UN";
        const bCountry = countryOf.get(bId) || "UN";

        const aTopics = topicsOf.get(aId) || [];
        const bTopics = topicsOf.get(bId) || [];
        const matchedTopics = aTopics.filter((t) => bTopics.includes(t));

        a.emit("partner-found", {
            partnerId: bId,
            initiator: initiator === aId,
            mode,
            country: bCountry,
            matchedTopics,
        });
        b.emit("partner-found", {
            partnerId: aId,
            initiator: initiator === bId,
            mode,
            country: aCountry,
            matchedTopics,
        });
    }
}

function breakPair(socket, notifyEvent) {
    const partner = safePartner(socket.id);
    const myId = socket.id;
    const partnerId = partnerOf.get(myId);

    if (partnerId) {
        partnerOf.delete(myId);
        partnerOf.delete(partnerId);
        if (partner && notifyEvent) partner.emit(notifyEvent);
    }
    const mode = modeOf.get(socket.id);
    if (mode) dequeue(mode, socket.id);
}

io.on("connection", async (socket) => {
    // detect IP
    const ip =
        socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        socket.handshake.address;

    // read cookie & decode for email
    let emailFromCookie = null;
    try {
        const cookieHeader = socket.handshake.headers.cookie || "";
        const sessionCookie = cookieHeader
            .split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith("session="));
        if (sessionCookie) {
            const token = decodeURIComponent(sessionCookie.split("=")[1]);
            const decoded = jwt.verify(token, JWT_SECRET);
            emailFromCookie = decoded?.email || null;
        }
    } catch {
        emailFromCookie = null;
    }

    // check active ban: email first, fallback IP
    const activeBan = await getActiveBan({ ip, email: emailFromCookie });
    if (activeBan) {
        socket.emit("banned", {
            reason: activeBan.reason,
            remaining: Math.ceil(
                (activeBan.expiry.getTime() - Date.now()) / 1000
            ),
            snapshot: activeBan.snapshotBase64 || null,
        });
        return;
    }

    broadcastOnlineCount();

    const geo = geoip.lookup(ip) || {};
    const country = geo?.country || "UN";
    countryOf.set(socket.id, country);
    socket.emit("your-info", { ip, geo });

    socket.on("find-partner", ({ mode, topics }) => {
        if (isTempBanned(ip)) {
            socket.emit("banned", {
                reason: "You are banned for inappropriate words.",
                remaining: Math.ceil((bannedIPs.get(ip) - Date.now()) / 1000),
            });
            return;
        }
        if (mode !== "video" && mode !== "text") mode = "video";
        breakPair(socket, null);
        enqueue(socket, mode);
        if (Array.isArray(topics)) {
            topicsOf.set(
                socket.id,
                topics.map((t) => String(t || "").toLowerCase())
            );
        } else {
            topicsOf.set(socket.id, []);
        }
        tryMatch(mode);
    });

    socket.on("signal", (payload) => {
        const partner = safePartner(socket.id);
        if (partner) partner.emit("signal", payload);
    });

    socket.on("message", async (msg) => {
        if (isTempBanned(ip)) {
            socket.emit("banned", {
                reason: "You are banned for inappropriate words.",
                remaining: Math.ceil((bannedIPs.get(ip) - Date.now()) / 1000),
            });
            return;
        }
        const partner = safePartner(socket.id);
        if (!partner) return;

        const partnerIp =
            partner.handshake.headers["x-forwarded-for"]
                ?.split(",")[0]
                ?.trim() ||
            partner.handshake.address ||
            null;

        const roomId = [socket.id, partner.id].sort().join("_");
        const isBad = filter.check(msg);

        if (isBad) {
            const count = (badWordCount.get(ip) || 0) + 1;
            badWordCount.set(ip, count);
            socket.emit("bad-word-warning", { text: msg, strikes: count });
            partner.emit("message", msg);
            partner.emit("warning", {
                text: msg,
                from: "partner",
                warning: "Disallowed content",
            });

            try {
                await new Message({
                    roomId,
                    text: msg,
                    senderIp: ip,
                    receiverIp: partnerIp,
                    senderSocketId: socket.id,
                    receiverSocketId: partner.id,
                    flagged: true,
                    reported: false,
                }).save();
            } catch (e) {
                console.error("Message save error (flagged):", e);
            }

            if (count >= 2) {
                const banTime = 60 * 1000;
                bannedIPs.set(ip, Date.now() + banTime);
                socket.emit("banned", {
                    reason: "You are banned for inappropriate text.",
                    remaining: Math.ceil(banTime / 1000),
                });
            }
            return;
        }

        partner.emit("message", msg);
        try {
            await new Message({
                roomId,
                text: msg,
                senderIp: ip,
                receiverIp: partnerIp,
                senderSocketId: socket.id,
                receiverSocketId: partner.id,
                reported: false,
            }).save();
        } catch (e) {
            console.error("Message save error:", e);
        }
    });

    socket.on("report-user", async (data) => {
        try {
            const {
                accusedIp: accIpFromClient,
                accusedSocketId,
                reason,
                scope,
            } = data || {};
            if (!accusedSocketId && !accIpFromClient) {
                socket.emit("report-error", {
                    error: "Missing accused identifier",
                });
                return;
            }
            let accusedIp = accIpFromClient || null;
            if (!accusedIp && accusedSocketId) {
                const accusedSock = io.sockets.sockets.get(accusedSocketId);
                accusedIp =
                    accusedSock?.handshake?.headers?.["x-forwarded-for"]
                        ?.split(",")[0]
                        ?.trim() ||
                    accusedSock?.handshake?.address ||
                    null;
            }
            if (!accusedIp) accusedIp = "unknown";

            const roomId = [socket.id, accusedSocketId]
                .filter(Boolean)
                .sort()
                .join("_");
            let msgs = await Message.find({ roomId }).sort({ createdAt: 1 });

            if (!msgs.length) {
                msgs = await Message.find({
                    $or: [
                        {
                            senderSocketId: socket.id,
                            receiverSocketId: accusedSocketId,
                        },
                        {
                            senderSocketId: accusedSocketId,
                            receiverSocketId: socket.id,
                        },
                        { senderIp: ip, receiverIp: accusedIp },
                        { senderIp: accusedIp, receiverIp: ip },
                    ],
                }).sort({ createdAt: 1 });
            }

            if (msgs.length) {
                const ids = msgs.map((m) => m._id);
                await Message.updateMany(
                    { _id: { $in: ids } },
                    { reported: true }
                );
            }

            const report = new Report({
                reporterIp: ip,
                accusedIp,
                reason:
                    reason ||
                    (scope ? `User report (${scope})` : "User report"),
                messages: msgs.map((m) => ({
                    text: m.text,
                    senderIp: m.senderIp,
                    receiverIp: m.receiverIp,
                    senderSocketId: m.senderSocketId,
                    receiverSocketId: m.receiverSocketId,
                    createdAt: m.createdAt,
                })),
            });
            await report.save();

            socket.emit("report-success", {
                message: "Report submitted to admin",
            });
            breakPair(socket, "partner-left");
            socket.emit("self-stopped");
            modeOf.delete(socket.id);
            countryOf.delete(socket.id);
            topicsOf.delete(socket.id);
        } catch (err) {
            console.error("Report error:", err);
            socket.emit("report-error", { error: "Failed to submit report" });
        }
    });

    socket.on("typing", () => {
        const partner = safePartner(socket.id);
        if (partner) partner.emit("typing");
    });
    socket.on("stop-typing", () => {
        const partner = safePartner(socket.id);
        if (partner) partner.emit("stop-typing");
    });

    socket.on("skip", () => {
        if (isTempBanned(ip)) {
            socket.emit("banned", {
                reason: "You are banned for inappropriate words.",
                remaining: Math.ceil((bannedIPs.get(ip) - Date.now()) / 1000),
            });
            return;
        }
        const mode = modeOf.get(socket.id) || "video";
        breakPair(socket, "partner-left");
        enqueue(socket, mode);
        tryMatch(mode);
    });

    socket.on("stop", () => {
        const partner = safePartner(socket.id);
        const myId = socket.id;
        if (partner) {
            partner.emit("partner-stopped");
            socket.emit("self-stopped");
            partnerOf.delete(myId);
            partnerOf.delete(partner.id);
            startedAt.delete(myId);
            startedAt.delete(partner.id);
        } else {
            socket.emit("self-stopped");
        }
        modeOf.delete(myId);
        countryOf.delete(myId);
        topicsOf.delete(myId);
    });

    socket.on("disconnect", () => {
        breakPair(socket, "partner-left");
        modeOf.delete(socket.id);
        countryOf.delete(socket.id);
        topicsOf.delete(socket.id);
        broadcastOnlineCount();
    });

    // Manual ban trigger (kept for compatibility)
    socket.on("banned", async (data) => {
        const duration = 10 * 60 * 1000;
        const expiry = new Date(Date.now() + duration);
        const banDoc = new Ban({
            ip,
            reason: data?.reason || "Inappropriate video content",
            expiry,
            snapshotBase64: data?.snapshot || null,
            status: "active",
        });
        await banDoc.save();
        socket.emit("banned", {
            reason: banDoc.reason,
            remaining: Math.ceil(duration / 1000),
            paymentUrl: banDoc.paymentUrl,
            snapshot: banDoc.snapshotBase64 || null,
        });
        console.log("🚫 User banned manually:", ip);
    });
});

// ---------------- Housekeeping ----------------
const PORT = process.env.PORT || 3001;

setInterval(async () => {
    try {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const res = await Message.deleteMany({
            createdAt: { $lt: oneHourAgo },
            reported: false,
        });
        if (res.deletedCount)
            console.log(
                `Auto-cleaner: deleted ${res.deletedCount} old messages`
            );
    } catch (err) {
        console.error("Auto-cleaner error:", err);
    }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
    console.log("✅ Signaling server listening on", PORT);
    console.log("🚀 Current App Version:", appVersion);
});

// --- Email-based ban/unban for logged-in users ---
app.post("/admin/ban-user-email", adminAuth, async (req, res) => {
    try {
        const { email, durationMs, reason } = req.body;
        if (!email) return res.status(400).json({ error: "email required" });
        const banDuration = durationMs || 10 * 60 * 1000;
        const expiry = new Date(Date.now() + banDuration);
        const ban = new Ban({
            email,
            ip: "email-ban",
            reason: reason || "Manual admin ban (email)",
            expiry,
            status: "active",
        });
        await ban.save();
        // optional: mark reports (if any) by accusedIp not possible via email; skip or extend schema
        res.json({ message: "User banned by email", ban });
    } catch (err) {
        console.error("Admin ban by email error:", err);
        res.status(500).json({ error: "Failed to ban by email" });
    }
});

app.post("/admin/unban-user-email", adminAuth, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "email required" });
        const upd = await Ban.updateMany(
            { email, status: "active" },
            {
                status: "closed",
                closedAt: new Date(),
                expiry: new Date(Date.now() - 1000),
            }
        );
        res.json({ message: "Unbanned by email", updated: upd.modifiedCount });
    } catch (err) {
        console.error("Admin unban by email error:", err);
        res.status(500).json({ error: "Failed to unban by email" });
    }
});

// --- Admin users list ---
app.get("/admin/users", adminAuth, async (_req, res) => {
    try {
        const users = await User.find({}).sort({ createdAt: -1 }).limit(500);
        res.json(users);
    } catch (e) {
        console.error("Admin users list error:", e);
        res.status(500).json({ error: "Failed to fetch users" });
    }
});
