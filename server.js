import express from "express";
import http from "http";
import { isIP } from "node:net";
import cors from "cors";
import axios from "axios";
import { Server as IOServer } from "socket.io";
import geoip from "geoip-lite";
import fs from "fs";
import path from "path";
import filter from "leo-profanity";
import mongoose from "mongoose";

// === Existing models ===
import Message from "./models/Message.js";
import Report from "./models/Report.js";

// === New user model ===
import User from "./models/User.js";

// Load local development configuration; hosted environment variables take precedence.
if (fs.existsSync('.env')) process.loadEnvFile('.env');

// Trust one platform proxy only when explicitly configured (Render sets RENDER).
function clientIp(req) {
    const direct = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    if (process.env.RENDER === 'true' || process.env.TRUST_PROXY === 'true') {
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1)?.trim();
        if (forwarded && isIP(forwarded)) return forwarded;
    }
    return direct;
}
const allowedOrigins = (process.env.FRONTEND_ORIGINS ||
    'http://localhost:4200,https://loop-chatx.vercel.app')
    .split(',').map(origin => origin.trim().replace(/\/$/, '')).filter(Boolean);
const corsOptions = { origin: allowedOrigins, credentials: true, methods: ['GET', 'POST', 'OPTIONS'] };

// ---------------- App & DB ----------------
const app = express();
app.use(cors(corsOptions));
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
});
const httpRates = new Map();
app.use((req, res, next) => {
    const key = clientIp(req) + ':' + (req.path.startsWith('/admin') ? 'admin' : 'api');
    const now = Date.now();
    let entry = httpRates.get(key);
    if (!entry || entry.until < now) { entry = { count: 0, until: now + 60000 }; httpRates.set(key, entry); }
    if (++entry.count > (req.path.startsWith('/admin') ? 60 : 240)) return res.status(429).json({ error: 'Too many requests' });
    next();
});
setInterval(() => { for (const [key, value] of httpRates) if (value.until < Date.now()) httpRates.delete(key); }, 60000).unref();
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use((req, res, next) => {
    if (req.body && (Array.isArray(req.body) || Object.values(req.body).some(value => value !== null && typeof value === 'object'))) {
        return res.status(400).json({ error: 'Only scalar fields are accepted' });
    }
    next();
});

mongoose
    .connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/chatapp", { serverSelectionTimeoutMS: 5000, bufferCommands: false })
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => {
        console.error('MongoDB connection failed:', err.name, err.code || 'unavailable');
        // Exit so the host can restart the service instead of serving broken chat indefinitely.
        process.exit(1);
    });

// ---------------- Env & Constants ----------------

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

app.use("/snapshots", adminAuth, express.static(path.join(process.cwd(), "snapshots")));

// ---------------- Admin auth (simple header check) ----------------
function adminAuth(req, res, next) {
    const user = req.headers["x-admin-user"];
    const pass = req.headers["x-admin-pass"];
    const token = req.headers["x-admin-token"];

    const ADMIN_USER = process.env.ADMIN_USER;
    const ADMIN_PASS = process.env.ADMIN_PASS;
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

    if (
        (ADMIN_USER && ADMIN_PASS && user === ADMIN_USER && pass === ADMIN_PASS) ||
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
app.get('/health', async (_req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) throw new Error('unavailable');
        await mongoose.connection.db.admin().command({ ping: 1 }, { timeoutMS: 3000 });
        res.json({ ok: true, database: 'connected' });
    } catch {
        res.status(503).json({ ok: false, database: 'unavailable' });
    }
});
app.get("/version", (req, res) => res.json({ version: appVersion }));
app.get("/check-outbound-ip", adminAuth, async (_req, res) => {
    try {
        const response = await axios.get("https://ifconfig.me/ip");
        res.json({ outboundIP: response.data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Safety restrictions cannot be bypassed by an unverified payment.
app.post('/api/create-payment', (_req, res) => res.status(410).json({ error: 'Payment unlock is unavailable' }));
app.get('/api/payment-status/:orderId', (_req, res) => res.status(410).json({ error: 'Payment unlock is unavailable' }));
app.get('/admin/session', adminAuth, (_req, res) => res.json({ ok: true }));

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
    try {
        const q = String(req.query.q || '').trim().slice(0, 100);
        const literal = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const query = q ? { $or: [{ email: new RegExp(literal, 'i') }, { name: new RegExp(literal, 'i') }] } : {};
        const users = await User.find(query).sort({ lastLoginAt: -1 }).limit(500);
        res.json(users);
    } catch { res.status(500).json({ error: 'Failed to fetch users' }); }
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
        if (ip) disconnectBannedIp(ip, ban);

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
        const report = await Report.findById(reportId);
        if (!report) return res.status(404).json({ error: 'Report not found' });
        if (update.status === 'banned') {
            const ban = await Ban.create({ ip: report.accusedIp, reason: 'Administrator reviewed report', expiry: new Date(Date.now() + 10 * 60 * 1000), status: 'active' });
            disconnectBannedIp(report.accusedIp, ban);
        }
        report.status = update.status;
        await report.save();
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
const io = new IOServer(server, { cors: corsOptions, maxHttpBufferSize: 32768,
    allowRequest: (req, done) => done(null, !req.headers.origin || allowedOrigins.includes(req.headers.origin))
});

// Finish the database-backed access check before accepting the socket.
// Otherwise an early find-partner event can arrive before its listener exists.
io.use(async (socket, next) => {
    const ip = clientIp(socket.request);
    socket.data.ip = ip;
    try {
        if (mongoose.connection.readyState !== 1) throw new Error('database unavailable');
        const activeBan = await getActiveBan({ ip });
        if (activeBan) {
            const error = new Error('BANNED');
            error.data = { reason: activeBan.reason, remaining: Math.ceil((activeBan.expiry.getTime() - Date.now()) / 1000) };
            return next(error);
        }
        next();
    } catch (error) {
        console.error('Socket access check failed:', error.name);
        const unavailable = new Error('DATABASE_UNAVAILABLE');
        unavailable.data = { retryable: true };
        next(unavailable);
    }
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
filter.add(["sex", "nude", "xxx"]);

// local temp bans for profanity
const badWordCount = new Map();
const bannedIPs = new Map();

function disconnectBannedIp(ip, ban) {
    for (const socket of io.sockets.sockets.values()) {
        if (socket.data.ip !== ip) continue;
        socket.emit('banned', { reason: ban.reason, remaining: Math.max(0, Math.ceil((ban.expiry.getTime() - Date.now()) / 1000)) });
        socket.disconnect(true);
    }
}

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
    let attempts = list.length;
    while (list.length >= 2 && attempts-- > 0) {
        const aId = list.shift();
        const aSocket = io.sockets.sockets.get(aId);
        const compatible = list.findIndex(id => !aSocket?.data.blocked?.has(id) && !io.sockets.sockets.get(id)?.data.blocked?.has(aId));
        if (compatible < 0) { list.push(aId); continue; }
        const bId = list.splice(compatible, 1)[0];
        const a = io.sockets.sockets.get(aId);
        const b = io.sockets.sockets.get(bId);
        if (!a || !b) {
            if (a) list.unshift(aId);
            if (b) list.unshift(bId);
            continue;
        }

        a.data.previousPartner = a.data.currentPartner;
        b.data.previousPartner = b.data.currentPartner;
        a.data.currentPartner = { id: bId, ip: b.data.ip };
        b.data.currentPartner = { id: aId, ip: a.data.ip };
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

io.on("connection", (socket) => {
    const ip = socket.data.ip;
    socket.data.blocked = new Set();
    const rates = new Map();
    socket.use(([event, payload], next) => {
        if (payload !== undefined && JSON.stringify(payload).length > 24000) return;
        if (!['find-partner','signal','message','report-user','block-user','typing','stop-typing','skip','stop'].includes(event)) return;
        const now = Date.now();
        const limit = ['report-user', 'block-user'].includes(event) ? 6 : event === 'signal' ? 100 : 30;
        let entry = rates.get(event);
        if (!entry || entry.until < now) { entry = { count: 0, until: now + 10000 }; rates.set(event, entry); }
        if (++entry.count > limit) { socket.emit('rate-limit', { message: 'Please slow down and try again shortly.' }); return; }
        next();
    });
    socket.on('block-user', () => {
        const partner = safePartner(socket.id);
        if (!partner) return;
        if (socket.data.blocked.size >= 100) { socket.emit('rate-limit'); return; }
        socket.data.blocked.add(partner.id);
        breakPair(socket, 'partner-stopped');
        socket.emit('self-stopped');
        socket.emit('block-success');
    });
    broadcastOnlineCount();

    const geo = geoip.lookup(ip) || {};
    const country = geo?.country || "UN";
    countryOf.set(socket.id, country);
    socket.emit("your-info", { country });

    socket.on("find-partner", (data) => {
        let { mode, topics } = data && typeof data === "object" ? data : {};
        if (isTempBanned(ip)) {
            socket.emit("banned", {
                reason: "You are banned for inappropriate words.",
                remaining: Math.ceil((bannedIPs.get(ip) - Date.now()) / 1000),
            });
            return;
        }
        if (mode !== "video" && mode !== "text") mode = "video";
        breakPair(socket, "partner-left");
        enqueue(socket, mode);
        if (Array.isArray(topics)) {
            topicsOf.set(
                socket.id,
                topics.filter(t => typeof t === "string").slice(0, 8).map(t => t.trim().slice(0, 40).toLowerCase())
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
        if (typeof msg !== "string" || !msg.trim() || msg.length > 4000) return;
        if (isTempBanned(ip)) {
            socket.emit("banned", {
                reason: "You are banned for inappropriate words.",
                remaining: Math.ceil((bannedIPs.get(ip) - Date.now()) / 1000),
            });
            return;
        }
        const partner = safePartner(socket.id);
        if (!partner) return;

        const partnerIp = partner.data.ip;

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
            const { accusedSocketId, scope } = data || {};
            const reason = typeof data?.reason === 'string' ? data.reason.trim().slice(0, 1000) : 'User report';
            const target = [socket.data.currentPartner, socket.data.previousPartner].find(p => p?.id === accusedSocketId);
            if (!target) { socket.emit('report-error', { error: 'Only your current or previous conversation can be reported' }); return; }
            const accusedIp = target.ip;
            const roomId = [socket.id, target.id].sort().join('_');
            const msgs = await Message.find({ roomId }).sort({ createdAt: 1 }).limit(200);

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
            if (socket.data.blocked.size < 100) socket.data.blocked.add(target.id);

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
        const queuedMode = modeOf.get(socket.id);
        if (queuedMode) dequeue(queuedMode, socket.id);
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
    // Client-side classification is not trusted evidence for an automatic ban.
    // The ordinary verified report workflow handles suspected video abuse.

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
