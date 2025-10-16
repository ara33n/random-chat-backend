import express from "express";
import http from "http";
import cors from "cors";
import axios from "axios";
import { Server as IOServer } from "socket.io";
import geoip from "geoip-lite";
import fs from "fs";
import path from "path";
import filter from "leo-profanity";
import mongoose from "mongoose";
import Payment from "./models/Payment.js";
import Message from "./models/Message.js";
import Report from "./models/Report.js";

const app = express();
app.use(cors());
app.use(express.json()); // ✅ JSON body parse
app.use(express.urlencoded({ extended: true })); // ✅ form data parse
// ✅ MongoDB connect
mongoose
    .connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/chatapp")
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => console.error("❌ MongoDB connect error:", err));
const API_KEY = "YYB93M2-WBMM0HH-N17825T-ERPG0QN";
// ✅ Ban Schema
const banSchema = new mongoose.Schema({
    ip: { type: String, required: true },
    reason: { type: String, required: true },
    expiry: { type: Date, required: true },
    snapshotBase64: { type: String },
    paymentRequired: { type: Boolean, default: false }, // ✅ Payment needed to unban
    paymentStatus: { type: String, default: "pending" }, // pending, success, cancelled
    paymentOrderId: { type: String }, // NOWPayments order_id
    paymentUrl: { type: String }, // Invoice URL
    createdAt: { type: Date, default: Date.now },
});

const Ban = mongoose.model("Ban", banSchema);

// ✅ Helper: check ban
async function getActiveBan(ip) {
    const ban = await Ban.findOne({ ip }).sort({ createdAt: -1 });
    if (!ban) return null;

    if (Date.now() > ban.expiry.getTime()) {
        // expired → keep record, but not active
        return null;
    }
    return ban;
}

// ✅ Version read from package.json
const pkgPath = path.join(process.cwd(), "package.json");
let appVersion = "1.0.1";
try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw);
    appVersion = parsed.version;
} catch (err) {
    console.warn("⚠️ Could not read package.json version, defaulting to 1.0.0");
}

app.use("/snapshots", express.static(path.join(process.cwd(), "snapshots")));

// ✅ Root route

// -------------------- Admin auth (simple header check) --------------------
function adminAuth(req, res, next) {
    // Accept either x-admin-user/x-admin-pass headers OR x-admin-token for compatibility
    const user = req.headers["x-admin-user"];
    const pass = req.headers["x-admin-pass"];
    const token = req.headers["x-admin-token"];
    // Default credentials as requested
    const ADMIN_USER = process.env.ADMIN_USER || "admin";
    const ADMIN_PASS = process.env.ADMIN_PASS || "Abcd!234";
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null; // optional

    if (
        (user === ADMIN_USER && pass === ADMIN_PASS) ||
        (token && token === ADMIN_TOKEN)
    ) {
        return next();
    }
    return res.status(403).json({ error: "Unauthorized" });
}
// -------------------------------------------------------------------------

app.get("/", (req, res) => {
    res.json({ ok: true, message: "Random Chat Signaling Server running." });
});

// ✅ Version route (frontend polls this)
app.get("/version", (req, res) => {
    res.json({ version: appVersion });
});

app.get("/check-outbound-ip", async (req, res) => {
    try {
        const response = await axios.get("https://ifconfig.me/ip");
        res.json({ outboundIP: response.data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// const API_KEY = "HE6RG28-3H041KW-G34730N-6ENC0GG";

// ✅ Create Payment
// ✅ Create Payment
app.post("/api/create-payment", async (req, res) => {
    try {
        const { amount, currency } = req.body;
        console.log("Incoming body:", req.body);

        // ✅ Use /v1/invoice instead of /v1/payment
        const response = await axios.post(
            "https://api.nowpayments.io/v1/invoice",
            {
                price_amount: amount,
                price_currency: currency,
                pay_currency: "icx", // coin of choice
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

        console.log("NOWPayments Invoice Response:", response.data);

        // ✅ Save in DB
        const newPayment = new Payment({
            orderId: response.data.order_id,
            amount: response.data.price_amount,
            currency: response.data.price_currency,
            payCurrency: response.data.pay_currency,
            paymentStatus: response.data.payment_status,
            paymentId: response.data.id, // invoice id
        });
        await newPayment.save();

        // ✅ Return hosted checkout link
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

// ✅ Webhook listener
app.post("/api/create-payment", async (req, res) => {
    try {
        const { ip, amount, currency } = req.body;
        console.log("Incoming body:", req.body);

        // 🔹 Step 1: Check if user is banned
        const ban = await Ban.findOne({ ip }).sort({ createdAt: -1 });
        if (!ban) {
            return res.status(400).json({ error: "User is not banned" });
        }

        // 🔹 Step 2: Create invoice on NOWPayments
        const response = await axios.post(
            "https://api.nowpayments.io/v1/invoice",
            {
                price_amount: amount || 5, // 💲 Default 5 USD to unban
                price_currency: currency || "usd",
                pay_currency: "icx", // fixed coin of choice
                order_id: "ban_" + Date.now(),
                order_description: "Ban removal fee",
                ipn_callback_url: `${
                    process.env.BASE_URL || "http://localhost:3001"
                }/api/payment-webhook`,
            },
            {
                headers: {
                    "x-api-key": API_KEY,
                    "Content-Type": "application/json",
                },
            }
        );

        console.log("NOWPayments Invoice Response:", response.data);

        // 🔹 Step 3: Update ban document with payment details
        ban.paymentRequired = true;
        ban.paymentOrderId = response.data.order_id;
        ban.paymentUrl = response.data.invoice_url;
        ban.paymentStatus = response.data.payment_status; // "waiting"
        await ban.save();

        // 🔹 Step 4: Also log payment in Payment collection
        const newPayment = new Payment({
            orderId: response.data.order_id,
            amount: response.data.price_amount,
            currency: response.data.price_currency,
            payCurrency: response.data.pay_currency,
            paymentStatus: response.data.payment_status,
            paymentId: response.data.id, // invoice id
            ip, // 👈 so we can link payment to user ban
        });
        await newPayment.save();

        // 🔹 Step 5: Return hosted checkout link to frontend
        res.json({
            payment_url: response.data.invoice_url,
            orderId: response.data.order_id,
            banReason: ban.reason,
            snapshot: ban.snapshotBase64 || null,
        });
    } catch (error) {
        console.error(
            "Create Invoice Error:",
            error.response?.data || error.message
        );
        res.status(500).json({ error: "Payment creation failed" });
    }
});

app.post("/api/payment-cancel", async (req, res) => {
    const { ip } = req.body;
    const ban = await Ban.findOne({ ip, paymentRequired: true });
    if (!ban) return res.status(404).json({ error: "No active ban" });

    ban.paymentStatus = "cancelled";
    ban.paymentOrderId = null;
    ban.paymentUrl = null;
    await ban.save();

    res.json({ message: "Payment cancelled, user can retry" });
});

// ✅ Payment Status check
app.get("/api/payment-status/:orderId", async (req, res) => {
    try {
        const { orderId } = req.params;

        const payment = await Payment.findOne({ orderId });

        if (!payment) {
            return res.status(404).json({ error: "Payment not found" });
        }

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

// -------------------- Admin API: reports, ban control --------------------

// Get all reports (admin)
app.get("/admin/reports", adminAuth, async (req, res) => {
    try {
        const reports = await Report.find().sort({ createdAt: -1 });
        res.json(reports);
    } catch (err) {
        console.error("Admin reports error:", err);
        res.status(500).json({ error: "Failed to fetch reports" });
    }
});

// Admin: ban a user (create Ban doc)
app.post("/admin/ban-user", adminAuth, async (req, res) => {
    try {
        const { ip, durationMs, reason } = req.body;
        const banDuration = durationMs || 10 * 60 * 1000; // 10 minutes default
        const expiry = new Date(Date.now() + banDuration);

        const ban = new Ban({
            ip,
            reason: reason || "Manual admin ban",
            expiry,
        });
        await ban.save();

        // mark related reports as banned
        await Report.updateMany({ accusedIp: ip }, { status: "banned" });

        res.json({ message: "User banned successfully", ban });
    } catch (err) {
        console.error("Admin ban error:", err);
        res.status(500).json({ error: "Failed to ban user" });
    }
});

// Admin: resolve a report
app.post("/admin/resolve-report", adminAuth, async (req, res) => {
    try {
        const { reportId, action } = req.body;
        if (!reportId)
            return res.status(400).json({ error: "reportId required" });
        const update = { status: "reviewed" };
        if (action === "ban") update.status = "banned";
        await Report.findByIdAndUpdate(reportId, update);
        res.json({ message: "Report updated" });
    } catch (err) {
        console.error("Resolve report error:", err);
        res.status(500).json({ error: "Failed to update report" });
    }
});

// -------------------------------------------------------------------------

const server = http.createServer(app);
const io = new IOServer(server, {
    // cors: {
    //     origin: [
    //         "https://loop-chatx.vercel.app",
    //         "http://localhost:4200",
    //         "https://strangtexx.onrender.com",
    //     ],
    //     methods: ["GET", "POST"],
    // },

    cors: { origin: "*", methods: ["GET", "POST"] },
});

// Queues
const queues = { video: [], text: [] };

// Maps
const partnerOf = new Map();
const modeOf = new Map();
const countryOf = new Map();
const startedAt = new Map();
const topicsOf = new Map(); // ✅ socket.id -> topics array

// ✅ Bad words list
const badWords = ["fuck", "shit", "bitch", "sex", "asshole", "islam"];

// ✅ Ban maps
const badWordCount = new Map(); // ip -> count
const bannedIPs = new Map(); // ip -> banExpiry timestamp

// ✅ Helper to send online count
function broadcastOnlineCount() {
    io.emit("online-count", { count: io.sockets.sockets.size });
}

filter.loadDictionary(); // ✅ load default bad words
filter.add(["sex", "nude", "xxx", "islam"]); // ✅ extra words if needed

// ✅ Ban check
function isBanned(ip) {
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

        // ✅ Topics match check from topicsOf map
        const aTopics = topicsOf.get(aId) || [];
        const bTopics = topicsOf.get(bId) || [];
        const matchedTopics = aTopics.filter((t) => bTopics.includes(t));

        // ✅ Send partner info with country + matched topics
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

        if (partner && notifyEvent) {
            partner.emit(notifyEvent);
        }
    }
    const mode = modeOf.get(socket.id);
    if (mode) dequeue(mode, socket.id);
}

io.on("connection", async (socket) => {
    // ✅ Detect IP (proxy safe)
    const ip =
        socket.handshake.headers["x-forwarded-for"]?.split(",")[0] ||
        socket.handshake.address;

    // ✅ Check active ban from DB on connection
    const activeBan = await getActiveBan(ip);
    if (activeBan) {
        socket.emit("banned", {
            reason: activeBan.reason,
            remaining: Math.ceil(
                (activeBan.expiry.getTime() - Date.now()) / 1000
            ),
            snapshot: activeBan.snapshotBase64 || null, // 👈 Base64 return
        });
        return; // ❌ Stop further processing
    }

    // ✅ Broadcast new online count
    broadcastOnlineCount();

    // ✅ Geo detect
    const geo = geoip.lookup(ip) || {};
    const country = geo?.country || "UN";

    countryOf.set(socket.id, country);
    socket.emit("your-info", { ip, geo });

    // ✅ Partner find with topics
    socket.on("find-partner", ({ mode, topics }) => {
        if (isBanned(ip)) {
            socket.emit("banned", {
                reason: "You are banned for inappropriate words.",
                remaining: Math.ceil((bannedIPs.get(ip) - Date.now()) / 1000),
            });
            return;
        }

        if (mode !== "video" && mode !== "text") mode = "video";
        breakPair(socket, null);
        enqueue(socket, mode);

        // Save topics
        if (Array.isArray(topics)) {
            topicsOf.set(
                socket.id,
                topics.map((t) => t.toLowerCase())
            );
        } else {
            topicsOf.set(socket.id, []);
        }

        tryMatch(mode);
    });

    // ✅ WebRTC signaling relay
    socket.on("signal", (payload) => {
        const partner = safePartner(socket.id);
        if (partner) partner.emit("signal", payload);
    });

    // ✅ Messages (with bad word check + ban)
    socket.on("message", (msg) => {
        // wrapped by moderation+storage
        if (isBanned(ip)) {
            socket.emit("banned", {
                reason: "You are banned for inappropriate words.",
                remaining: Math.ceil((bannedIPs.get(ip) - Date.now()) / 1000),
            });
            return;
        }

        const partner = safePartner(socket.id);

        if (filter.check(msg)) {
            const count = (badWordCount.get(ip) || 0) + 1;
            badWordCount.set(ip, count);

            socket.emit("bad-word-warning", { text: msg, strikes: count });

            if (count >= 2) {
                const banTime = 60 * 1000;
                bannedIPs.set(ip, Date.now() + banTime);

                socket.emit("banned", {
                    reason: "You are banned for inappropriate text.",
                    remaining: Math.ceil(banTime / 1000),
                });

                return;
            }
            return;
        }

        if (partner) partner.emit("message", msg);
    });

    // ✅ Reporting by user
    socket.on("report-user", async (data) => {
        try {
            const { accusedIp, accusedSocketId, reason } = data || {};
            // find messages between this socket and accused (by socket ids or ip)
            const msgs = await Message.find({
                $or: [
                    { senderIp: ip, receiverIp: accusedIp },
                    { senderIp: accusedIp, receiverIp: ip },
                    {
                        senderSocketId: socket.id,
                        receiverSocketId: accusedSocketId,
                    },
                    {
                        senderSocketId: accusedSocketId,
                        receiverSocketId: socket.id,
                    },
                ],
            }).sort({ createdAt: 1 });

            // mark these messages as reported so they won't be auto-deleted
            const ids = msgs.map((m) => m._id);
            if (ids.length)
                await Message.updateMany(
                    { _id: { $in: ids } },
                    { reported: true }
                );

            const report = new Report({
                reporterIp: ip,
                accusedIp: accusedIp || null,
                reason: reason || "User report",
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
            console.log("Report created:", report._id);
        } catch (err) {
            console.error("Report error:", err);
            socket.emit("report-error", { error: "Failed to submit report" });
        }
    });

    // ✅ Typing indicator
    socket.on("typing", () => {
        const partner = safePartner(socket.id);
        if (partner) partner.emit("typing");
    });
    socket.on("stop-typing", () => {
        const partner = safePartner(socket.id);
        if (partner) partner.emit("stop-typing");
    });

    // ✅ Skip
    socket.on("skip", () => {
        if (isBanned(ip)) {
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

    // ✅ Stop
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

    // ✅ Manual ban trigger
    socket.on("banned", async (data) => {
        const duration = 10 * 60 * 1000;
        const expiry = new Date(Date.now() + duration);

        const banDoc = new Ban({
            ip,
            reason: data?.reason || "Inappropriate video content",
            expiry,
            snapshotBase64: data?.snapshot || null,
        });
        await banDoc.save();

        socket.emit("banned", {
            reason: banDoc.reason,
            remaining: Math.ceil(duration / 1000),
            paymentUrl: banDoc.paymentUrl, // 👈 show in frontend
            snapshot: banDoc.snapshotBase64 || null,
        });

        console.log("🚫 User banned manually:", ip);
    });

    // ✅ Snapshot folder ensure
    const SNAPSHOT_DIR = path.join(process.cwd(), "snapshots");
    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR);

    // ✅ NSFW report
    socket.on("report-nsfw", async (data) => {
        try {
            const duration = 60 * 1000; // 1 min ban
            const expiry = new Date(Date.now() + duration);

            let snapshotBase64 = null;
            if (data?.snapshot) {
                snapshotBase64 = data.snapshot; // 👈 Base64 direct store
            }

            const banDoc = new Ban({
                ip,
                reason: data?.reason || "Nudity detected",
                expiry,
                snapshotBase64, // 👈 store base64 instead of file path
            });
            await banDoc.save();

            // ❌ Immediately disconnect from partner
            breakPair(socket, "partner-left");

            socket.emit("banned", {
                reason: banDoc.reason,
                remaining: Math.ceil((expiry.getTime() - Date.now()) / 1000),
                paymentUrl: banDoc.paymentUrl, // 👈 show in frontend
                snapshot: snapshotBase64 || null, // 👈 send base64 back to frontend
            });

            console.log("🚫 NSFW ban saved:", banDoc._id);
        } catch (err) {
            console.error("❌ Ban save error:", err);
        }
    });
});

const PORT = process.env.PORT || 3001;

// -------------------- Auto-cleaner: delete non-reported messages older than 1 hour --------------------
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
// -------------------------------------------------------------------------

server.listen(PORT, () => {
    console.log("✅ Signaling server listening on", PORT);
    console.log("🚀 Current App Version:", appVersion);
});
