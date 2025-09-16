import express from "express";
import http from "http";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import geoip from "geoip-lite";
import fs from "fs";
import path from "path";
import filter from "leo-profanity";
import mongoose from "mongoose";

const app = express();
app.use(cors());
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
    snapshotPath: { type: String },
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
            snapshot: activeBan.snapshotPath
                ? `/snapshots/${path.basename(activeBan.snapshotPath)}`
                : null,
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
    socket.on("banned", (data) => {
        const duration = 10 * 60 * 1000;
        bannedIPs.set(ip, Date.now() + duration);

        socket.emit("banned", {
            reason: data?.reason || "Inappropriate video content",
            remaining: Math.ceil(duration / 1000),
        });

        console.log("🚫 User banned manually (nudity/NSFW):", ip);
    });

    // ✅ Snapshot folder ensure
    const SNAPSHOT_DIR = path.join(process.cwd(), "snapshots");
    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR);

    // ✅ NSFW report
    socket.on("report-nsfw", async (data) => {
        try {
            const duration = 60 * 1000;
            const expiry = new Date(Date.now() + duration);

            let snapshotPath = null;
            if (data?.snapshot) {
                const base64Data = data.snapshot.replace(
                    /^data:image\/\w+;base64,/,
                    ""
                );
                const fileName = `ban_${Date.now()}_${ip.replace(
                    /[:.]/g,
                    "_"
                )}.jpg`;
                snapshotPath = path.join(SNAPSHOT_DIR, fileName);
                fs.writeFileSync(snapshotPath, base64Data, "base64");
            }

            const banDoc = new Ban({
                ip,
                reason: data?.reason || "Nudity detected",
                expiry,
                snapshotPath,
            });
            await banDoc.save();

            socket.emit("banned", {
                reason: banDoc.reason,
                remaining: Math.ceil((expiry.getTime() - Date.now()) / 1000),
                snapshot: snapshotPath
                    ? `/snapshots/${path.basename(snapshotPath)}`
                    : null,
            });

            console.log("🚫 NSFW ban saved:", banDoc);
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
