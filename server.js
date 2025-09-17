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

const app = express();
app.use(cors());
app.use(express.json()); // ✅ JSON body parse
app.use(express.urlencoded({ extended: true })); // ✅ form data parse
// ✅ MongoDB connect
mongoose
    .connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/chatapp")
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => console.error("❌ MongoDB connect error:", err));

// ✅ Ban Schema
const banSchema = new mongoose.Schema({
    ip: { type: String, required: true },
    reason: { type: String, required: true },
    expiry: { type: Date, required: true },
    snapshotBase64: { type: String },
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
const API_KEY = "YYB93M2-WBMM0HH-N17825T-ERPG0QN";

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
app.post("/api/payment-webhook", async (req, res) => {
    try {
        const data = req.body;
        console.log("NOWPayments webhook:", data);

        // 🔹 Update payment in DB
        const updated = await Payment.findOneAndUpdate(
            { orderId: data.order_id }, // ya paymentId: data.payment_id
            {
                paymentId: data.payment_id,
                orderId: data.order_id,
                paymentStatus: data.payment_status,
                txHash: data.payin_hash || null,
                amount: data.price_amount,
                currency: data.price_currency,
                payCurrency: data.pay_currency,
                amountReceived:
                    data.amount_received || data.actually_paid || null,
                updatedAt: data.updated_at || new Date(),
                raw: data, // 👈 full webhook payload store for reference
            },
            { new: true, upsert: true } // agar record na mile to create bhi kar dega
        );

        console.log("Payment updated:", updated);

        res.json({ message: "Webhook received" });
    } catch (err) {
        console.error("Webhook Error:", err);
        res.status(500).json({ error: "Webhook failed" });
    }
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
const badWords = ["fuck", "shit", "bitch", "sex", "asshole"];

// ✅ Ban maps
const badWordCount = new Map(); // ip -> count
const bannedIPs = new Map(); // ip -> banExpiry timestamp

// ✅ Helper to send online count
function broadcastOnlineCount() {
    io.emit("online-count", { count: io.sockets.sockets.size });
}

filter.loadDictionary(); // ✅ load default bad words
filter.add(["sex", "nude", "xxx"]); // ✅ extra words if needed

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

            socket.emit("banned", {
                reason: banDoc.reason,
                remaining: Math.ceil((expiry.getTime() - Date.now()) / 1000),
                snapshot: snapshotBase64 || null, // 👈 send base64 back to frontend
            });

            console.log("🚫 NSFW ban saved:", banDoc._id);
        } catch (err) {
            console.error("❌ Ban save error:", err);
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log("✅ Signaling server listening on", PORT);
    console.log("🚀 Current App Version:", appVersion);
});
