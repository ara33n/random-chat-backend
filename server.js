import { priceHandlers } from './payments/price.js';
import { paddleConfiguration, paddlePriceConfiguration } from './payments/diagnostics.js';
import { adminAuth } from './auth/admin.js';
import express from "express";
import { createBanToken } from "./payments/ban-token.js";
import { paddleHandlers, UnbanPayment } from "./payments/paddle.js";
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
import { randomUUID } from "node:crypto";
import { BAN_DURATIONS_MS, BAN_RESET_MS, nextBanPolicy } from "./moderation/ban-policy.js";
import { asksForAge, declaredUnderage, underageShortAnswer } from "./moderation/age-policy.js";

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
// Deliberately fixed: stale hosting environment values cannot allow other websites.
const allowedOrigins = ['https://loopchatx.chat', 'https://www.loopchatx.chat'];
const corsOptions = { maxAge: 600, origin: allowedOrigins, credentials: true, methods: ['GET', 'POST', 'OPTIONS'] };

// ---------------- App & DB ----------------
const app = express();
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return res.status(403).json({ error: 'Origin not allowed' });
    next();
});
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
console.info('[Paddle] configuration', paddleConfiguration());
console.info('[Paddle] price configuration', paddlePriceConfiguration());
const paddle = paddleHandlers({ getBanModel: () => Ban, getActiveBan, clientIp });
app.post('/api/paddle/webhook', express.raw({ type: 'application/json', limit: '256kb' }), paddle.webhook);
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
    evidenceFrames: { type: [String], select: false, default: undefined },
    paymentRequired: { type: Boolean, default: false },
    paymentStatus: { type: String, default: "pending" }, // pending, success, cancelled
    status: { type: String, enum: ["active", "closed"], default: "active" },
    closedAt: { type: Date },
    paymentOrderId: { type: String },
    paymentUrl: { type: String },
    reactivationEligible: { type: Boolean, default: false },
    source: { type: String, enum: ["moderation", "admin", "age"], default: "admin" },
    banLevel: { type: Number, min: 1, max: 3, default: 1 },
    escalationResetAt: { type: Date },
    appealToken: { type: String, unique: true, sparse: true, select: false },
    appealStatus: { type: String, enum: ["none", "pending", "approved", "rejected"], default: "none" },
    appealReason: { type: String },
    appealRequestedAt: { type: Date },
    appealReviewedAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
});
const Ban = mongoose.model("Ban", banSchema);

async function createModerationBan(ip, reason, reactivationEligible = false) {
    const now = Date.now();
    const lastBan = await Ban.findOne({ ip, source: "moderation", createdAt: { $gt: new Date(now - BAN_RESET_MS) } })
        .sort({ createdAt: -1 }).select("banLevel createdAt").lean();
    const policy = nextBanPolicy(lastBan, now);
    return Ban.create({
        ip, reason, expiry: new Date(now + policy.durationMs), status: "active",
        source: "moderation", banLevel: policy.banLevel,
        escalationResetAt: policy.escalationResetAt, reactivationEligible,
        appealToken: randomUUID(),
    });
}

function createAgeRestriction(ip) {
    return createModerationBan(ip, 'Age requirement violation: LoopChatX is only available to people aged 18 or older.', false);
}

function publicBanData(ban) {
    return {
        paymentEligible: ban.reactivationEligible === true,
        ...(ban.reactivationEligible === true ? { banToken: createBanToken(ban) } : {}),
        appealToken: ban.appealToken,
        appealStatus: ban.appealStatus || "none",
        ...(ban.snapshotBase64 ? { snapshot: ban.snapshotBase64 } : {}),
        expiresAt: ban.expiry.toISOString(), reason: ban.reason,
        remaining: Math.max(0, Math.ceil((ban.expiry.getTime() - Date.now()) / 1000)),
    };
}

// ---------------- Helpers ----------------
async function getActiveBan({ ip, email }) {
    // Prefer email if present
    let q = email ? { email, status: "active" } : { ip, status: "active" };
    let ban = await Ban.findOne({ ...q, expiry: { $gt: new Date() } }).select('+appealToken').sort({ createdAt: -1 });
    if (!ban && email && ip) {
        // fallback to IP if email ban not found
        ban = await Ban.findOne({ ip, status: "active", expiry: { $gt: new Date() } }).select('+appealToken').sort({
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

app.use("/snapshots", adminAuth, express.static(path.join(process.cwd(), "snapshots")));

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
app.get("/check-outbound-ip", adminAuth, async (_req, res) => {
    try {
        const response = await axios.get("https://ifconfig.me/ip");
        res.json({ outboundIP: response.data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Legacy payment routes stay retired; only verified Paddle webhooks can unlock a ban.
app.post('/api/paddle/checkout', paddle.checkout);
app.get('/api/paddle/status/:orderId', paddle.status);
app.post('/api/create-payment', (_req, res) => res.status(410).json({ error: 'Payment unlock is unavailable' }));
app.get('/api/payment-status/:orderId', (_req, res) => res.status(410).json({ error: 'Payment unlock is unavailable' }));
app.get('/api/paddle/price', priceHandlers.get);
app.get('/admin/paddle/price', adminAuth, priceHandlers.get);
app.post('/admin/paddle/price', adminAuth, priceHandlers.update);
app.get('/admin/session', adminAuth, (_req, res) => res.json({ ok: true }));

app.post('/api/ban-appeal', async (req, res) => {
    const token = typeof req.body?.appealToken === 'string' ? req.body.appealToken.trim() : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
    if (!/^[0-9a-f-]{36}$/i.test(token) || reason.length < 10)
        return res.status(400).json({ error: 'Add a brief reason for your review request.' });
    try {
        const ban = await Ban.findOne({ appealToken: token, status: 'active', expiry: { $gt: new Date() } }).select('+appealToken');
        if (!ban) return res.status(404).json({ error: 'This restriction is no longer available for review.' });
        if (ban.appealStatus === 'pending') return res.json({ status: 'pending' });
        if (ban.appealStatus !== 'none') return res.status(409).json({ error: 'This review request has already been decided.' });
        ban.appealStatus = 'pending';
        ban.appealReason = reason;
        ban.appealRequestedAt = new Date();
        await ban.save();
        res.json({ status: 'pending' });
    } catch (error) {
        console.error('Ban appeal request failed:', error.name);
        res.status(503).json({ error: 'Unable to send the review request. Please try again.' });
    }
});

app.post('/api/ban-appeal/status', async (req, res) => {
    const token = typeof req.body?.appealToken === 'string' ? req.body.appealToken.trim() : '';
    if (!/^[0-9a-f-]{36}$/i.test(token)) return res.status(400).json({ error: 'Valid review token required.' });
    try {
        const ban = await Ban.findOne({ appealToken: token }).select('+appealToken appealStatus status expiry');
        if (!ban) return res.status(404).json({ error: 'Review request not found.' });
        const active = ban.status === 'active' && ban.expiry.getTime() > Date.now();
        res.json({ status: ban.appealStatus || 'none', active });
    } catch (error) {
        console.error('Ban appeal status failed:', error.name);
        res.status(503).json({ error: 'Unable to check the review request.' });
    }
});

function ipLocation(ip) {
    const location = geoip.lookup(String(ip || '').replace(/^::ffff:/, ''));
    return { country: location?.country || '', region: location?.region || '', city: location?.city || '' };
}

app.get('/admin/payments', adminAuth, async (_req, res) => {
    try {
        const payments = await UnbanPayment.find({ status: 'completed' })
            .select('orderId banId ip transactionId status amountMinor currency completedAt environment createdAt')
            .sort({ completedAt: -1, createdAt: -1 }).limit(500).lean();
        res.json(payments);
    } catch { res.status(503).json({ error: 'Unable to load payments' }); }
});

// ---------------- Admin: Reports & Bans ----------------
app.get("/admin/reports", adminAuth, async (_req, res) => {
    try {
        const reports = await Report.find().sort({ createdAt: -1 }).lean();
        res.json(reports.map(report => ({ ...report,
            reporterLocation: report.reporterLocation?.country ? report.reporterLocation : ipLocation(report.reporterIp),
            accusedLocation: report.accusedLocation?.country ? report.accusedLocation : ipLocation(report.accusedIp),
        })));
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
            source: "admin",
            appealToken: randomUUID(),
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
            ban = await Ban.findOne({ ip, status: "active", expiry: { $gt: new Date() } }).sort({
                createdAt: -1,
            });
        if (!ban)
            return res.status(404).json({ error: "Active ban not found" });

        ban.status = "closed";
        ban.closedAt = new Date();
        if (ban.expiry > new Date()) ban.expiry = new Date(Date.now() - 1000);
        await ban.save();
        clearRuntimeBan(ban.ip);

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
            const ban = await createModerationBan(report.accusedIp, 'Administrator reviewed report');
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
        const q = activeOnly ? { status: "active", expiry: { $gt: new Date() } } : {};
        const bans = await Ban.find(q).select('+evidenceFrames').sort({ createdAt: -1 }).limit(500);
        res.json(bans.map(ban => {
            const item = ban.toObject();
            if (item.appealStatus !== 'pending') delete item.evidenceFrames;
            return item;
        }));
    } catch (e) {
        console.error("Admin bans list error:", e);
        res.status(500).json({ error: "Failed to fetch bans" });
    }
});

app.post('/admin/ban-appeal', adminAuth, async (req, res) => {
    const banId = typeof req.body?.banId === 'string' ? req.body.banId : '';
    const action = String(req.body?.action || '');
    if (!/^[a-f0-9]{24}$/i.test(banId) || !['approve', 'reject'].includes(action))
        return res.status(400).json({ error: 'Valid banId and action are required' });
    try {
        const ban = await Ban.findOne({ _id: banId, appealStatus: 'pending' });
        if (!ban) return res.status(404).json({ error: 'Pending review request not found' });
        ban.appealStatus = action === 'approve' ? 'approved' : 'rejected';
        ban.appealReviewedAt = new Date();
        if (action === 'approve') {
            ban.status = 'closed';
            ban.closedAt = new Date();
            ban.expiry = new Date(Date.now() - 1000);
        }
        await ban.save();
        if (action === 'approve') clearRuntimeBan(ban.ip);
        res.json({ message: `Review request ${ban.appealStatus}`, ban });
    } catch (error) {
        console.error('Ban appeal review failed:', error.name);
        res.status(503).json({ error: 'Unable to review request' });
    }
});

// ---------------- Socket.io ----------------
const server = http.createServer(app);
const io = new IOServer(server, { cors: corsOptions, maxHttpBufferSize: 350000,
    allowRequest: (req, done) => done(null, allowedOrigins.includes(req.headers.origin))
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
            error.data = publicBanData(activeBan);
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

function clearRuntimeBan(ip) {
    if (!ip) return;
    bannedIPs.delete(ip);
    badWordCount.delete(ip);
}

function disconnectBannedIp(ip, ban) {
    for (const socket of io.sockets.sockets.values()) {
        if (socket.data.ip !== ip) continue;
        const partner = io.sockets.sockets.get(partnerOf.get(socket.id));
        partner?.emit('partner-banned');
        socket.emit('banned', publicBanData(ban));
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
        clearRuntimeBan(ip);
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
    const rates = new Map();
    socket.use(([event, payload], next) => {
        const payloadLimit = event === 'video-violation' ? 300000 : 24000;
        if (payload !== undefined && JSON.stringify(payload).length > payloadLimit) return;
        if (!['find-partner','signal','message','report-user','video-violation','typing','stop-typing','skip','stop'].includes(event)) return;
        const now = Date.now();
        const limit = ['report-user', 'video-violation'].includes(event) ? 6 : event === 'signal' ? 100 : 30;
        let entry = rates.get(event);
        if (!entry || entry.until < now) { entry = { count: 0, until: now + 10000 }; rates.set(event, entry); }
        if (++entry.count > limit) { socket.emit('rate-limit', { message: 'Please slow down and try again shortly.' }); return; }
        next();
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
                expiresAt: new Date(bannedIPs.get(ip)).toISOString(),
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
                expiresAt: new Date(bannedIPs.get(ip)).toISOString(),
                remaining: Math.ceil((bannedIPs.get(ip) - Date.now()) / 1000),
            });
            return;
        }
        const partner = safePartner(socket.id);
        if (!partner) return;

        const ageReplyExpected = Number(socket.data.ageReplyExpectedUntil) > Date.now();
        socket.data.ageReplyExpectedUntil = 0;
        if (declaredUnderage(msg) || (ageReplyExpected && underageShortAnswer(msg))) {
            try {
                const ban = await createAgeRestriction(ip);
                bannedIPs.set(ip, ban.expiry.getTime());
                badWordCount.delete(ip);
                disconnectBannedIp(ip, ban);
            } catch (error) {
                console.error('Age restriction save failed:', error.name);
                socket.emit('server-error', { error: 'Unable to apply the age restriction safely.' });
                socket.disconnect(true);
            }
            return;
        }

        if (asksForAge(msg)) partner.data.ageReplyExpectedUntil = Date.now() + 2 * 60 * 1000;

        const partnerIp = partner.data.ip;

        const roomId = [socket.id, partner.id].sort().join("_");
        const isBad = filter.check(msg);

        if (isBad) {
            const count = (badWordCount.get(ip) || 0) + 1;
            badWordCount.set(ip, count);
            // Block additional messages while the persistent ban is being saved.
            if (count >= 2) bannedIPs.set(ip, Date.now() + BAN_DURATIONS_MS[0]);
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
                try {
                    const ban = await createModerationBan(ip, 'You are banned for inappropriate text.', true);
                    bannedIPs.set(ip, ban.expiry.getTime());
                    badWordCount.delete(ip);
                    disconnectBannedIp(ip, ban);
                } catch {
                    // Fail closed if MongoDB is unavailable; do not sell an unsaved restriction.
                    partner.emit('partner-banned');
                    socket.emit('banned', {
                        reason: 'You are banned for inappropriate text. Payment is temporarily unavailable.',
                        remaining: Math.max(0, Math.ceil((bannedIPs.get(ip) - Date.now()) / 1000)),
                        expiresAt: new Date(bannedIPs.get(ip)).toISOString(),
                        paymentEligible: false,
                    });
                    breakPair(socket, 'partner-stopped');
                }
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

    socket.on('video-violation', async (data) => {
        try {
            const partner = safePartner(socket.id);
            const accusedSocketId = typeof data?.accusedSocketId === 'string' ? data.accusedSocketId : '';
            if (!partner || partner.id !== accusedSocketId || modeOf.get(socket.id) !== 'video') return;
            if (socket.data.videoViolationPartnerId === accusedSocketId) return;
            const before = Array.isArray(data?.before) ? data.before : [];
            const after = Array.isArray(data?.after) ? data.after : [];
            const trigger = typeof data?.trigger === 'string' ? data.trigger : '';
            const validFrame = frame => typeof frame === 'string' && /^data:image\/jpeg;base64,[a-z0-9+/=]+$/i.test(frame) && frame.length <= 30000;
            if (before.length !== 4 || after.length !== 4 || !validFrame(trigger) || !before.every(validFrame) || !after.every(validFrame)) return;
            socket.data.videoViolationPartnerId = accusedSocketId;
            const ban = await createModerationBan(partner.data.ip, 'Explicit video content detected during a video chat.', false);
            ban.snapshotBase64 = trigger;
            ban.evidenceFrames = [...before, trigger, ...after];
            await ban.save();
            disconnectBannedIp(partner.data.ip, ban);
            socket.emit('video-violation-recorded');
        } catch (error) {
            console.error('Video violation handling failed:', error.name);
            socket.emit('server-error', { error: 'Unable to save the video moderation evidence.' });
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
                reporterLocation: ipLocation(ip),
                accusedLocation: ipLocation(accusedIp),
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
                expiresAt: new Date(bannedIPs.get(ip)).toISOString(),
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
