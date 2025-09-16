import express from "express";
import http from "http";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import geoip from "geoip-lite";
import fs from "fs";
import path from "path";
import filter from "leo-profanity";

const app = express();
app.use(cors());

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
    cors: {
        origin: [
            "https://loop-chatx.vercel.app",
            "http://localhost:4200",
            "https://strangtexx.onrender.com",
        ],
        methods: ["GET", "POST"],
    },
});

// Queues
const queues = { video: [], text: [] };

// Maps
const partnerOf = new Map();
const modeOf = new Map();
const countryOf = new Map();
const startedAt = new Map();
const topicsOf = new Map(); // ✅ socket.id -> topics array

// ✅ Ban maps
// ip -> { expiry, snapshotPath }
const badWordCount = new Map();
const bannedIPs = new Map();

// ✅ Ensure folders
const SNAPSHOT_DIR = path.join(process.cwd(), "snapshots");
const ARCHIVE_DIR = path.join(process.cwd(), "snapshots_archive");
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

// ✅ Helper to send online count
function broadcastOnlineCount() {
    io.emit("online-count", { count: io.sockets.sockets.size });
}

filter.loadDictionary();
filter.add(["sex", "nude", "xxx"]);

// ✅ Ban check
function isBanned(ip) {
    const entry = bannedIPs.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.expiry) {
        // Ban expired → move snapshot to archive
        if (entry.snapshotPath) {
            const filename = path.basename(entry.snapshotPath);
            const archiveName = `${Date.now()}_${filename}`;
            const archivePath = path.join(ARCHIVE_DIR, archiveName);
            try {
                fs.renameSync(entry.snapshotPath, archivePath);
                console.log("📦 Snapshot archived:", archivePath);
            } catch (err) {
                console.error("❌ Snapshot archive failed:", err);
            }
        }
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

        if (partner && notifyEvent) {
            partner.emit(notifyEvent);
        }
    }
    const mode = modeOf.get(socket.id);
    if (mode) dequeue(mode, socket.id);
}

io.on("connection", (socket) => {
    broadcastOnlineCount();

    const ip =
        socket.handshake.headers["x-forwarded-for"]?.split(",")[0] ||
        socket.handshake.address;

    const geo = geoip.lookup(ip) || {};
    const country = geo?.country || "UN";
    countryOf.set(socket.id, country);

    socket.emit("your-info", { ip, geo });

    // ✅ Check if already banned
    if (isBanned(ip)) {
        const entry = bannedIPs.get(ip);
        socket.emit("banned", {
            reason: "You are banned.",
            remaining: Math.ceil((entry.expiry - Date.now()) / 1000),
            snapshot: entry.snapshotPath
                ? `/snapshots/${path.basename(entry.snapshotPath)}`
                : null,
        });
        return;
    }

    // ✅ Partner find with topics
    socket.on("find-partner", ({ mode, topics }) => {
        if (isBanned(ip)) {
            const entry = bannedIPs.get(ip);
            socket.emit("banned", {
                reason: "You are banned.",
                remaining: Math.ceil((entry.expiry - Date.now()) / 1000),
                snapshot: entry.snapshotPath
                    ? `/snapshots/${path.basename(entry.snapshotPath)}`
                    : null,
            });
            return;
        }

        if (mode !== "video" && mode !== "text") mode = "video";
        breakPair(socket, null);
        enqueue(socket, mode);

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

    // ✅ WebRTC relay
    socket.on("signal", (payload) => {
        const partner = safePartner(socket.id);
        if (partner) partner.emit("signal", payload);
    });

    // ✅ Messages
    socket.on("message", (msg) => {
        if (isBanned(ip)) {
            const entry = bannedIPs.get(ip);
            socket.emit("banned", {
                reason: "You are banned.",
                remaining: Math.ceil((entry.expiry - Date.now()) / 1000),
                snapshot: entry.snapshotPath
                    ? `/snapshots/${path.basename(entry.snapshotPath)}`
                    : null,
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
                bannedIPs.set(ip, {
                    expiry: Date.now() + banTime,
                    snapshotPath: null,
                });

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

    socket.on("typing", () => {
        const partner = safePartner(socket.id);
        if (partner) partner.emit("typing");
    });
    socket.on("stop-typing", () => {
        const partner = safePartner(socket.id);
        if (partner) partner.emit("stop-typing");
    });

    socket.on("skip", () => {
        if (isBanned(ip)) {
            const entry = bannedIPs.get(ip);
            socket.emit("banned", {
                reason: "You are banned.",
                remaining: Math.ceil((entry.expiry - Date.now()) / 1000),
                snapshot: entry.snapshotPath
                    ? `/snapshots/${path.basename(entry.snapshotPath)}`
                    : null,
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

    // ✅ Manual ban trigger
    socket.on("banned", (data) => {
        const duration = 10 * 60 * 1000;
        bannedIPs.set(ip, {
            expiry: Date.now() + duration,
            snapshotPath: null,
        });

        socket.emit("banned", {
            reason: data?.reason || "Inappropriate video content",
            remaining: Math.ceil(duration / 1000),
        });

        console.log("🚫 User banned manually:", ip);
    });

    // ✅ NSFW report from frontend
    socket.on("report-nsfw", (data) => {
        const duration = 60 * 1000;
        const expiry = Date.now() + duration;

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

        bannedIPs.set(ip, { expiry, snapshotPath });

        socket.emit("banned", {
            reason: data?.reason || "Nudity detected",
            remaining: Math.ceil(duration / 1000),
            snapshot: snapshotPath
                ? `/snapshots/${path.basename(snapshotPath)}`
                : null,
        });

        console.log("🚫 NSFW ban:", ip, "->", snapshotPath);
    });
});

// ✅ Serve snapshots & archive
app.use("/snapshots", express.static(SNAPSHOT_DIR));
app.use("/snapshots-archive", express.static(ARCHIVE_DIR));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log("✅ Signaling server listening on", PORT);
    console.log("🚀 Current App Version:", appVersion);
});
