import express from "express";
import http from "http";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import geoip from "geoip-lite";

const app = express();
app.use(cors());

// ✅ Root route
app.get("/", (req, res) => {
    res.json({ ok: true, message: "Random Chat Signaling Server running." });
});

const server = http.createServer(app);
const io = new IOServer(server, {
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

io.on("connection", (socket) => {
    // ✅ Detect IP (proxy safe)
    const ip =
        socket.handshake.headers["x-forwarded-for"]?.split(",")[0] ||
        socket.handshake.address;

    const geo = geoip.lookup(ip) || {};
    const country = geo?.country || "UN";

    countryOf.set(socket.id, country);

    socket.emit("your-info", { ip, geo });

    // ✅ Partner find with topics
    socket.on("find-partner", ({ mode, topics }) => {
        if (mode !== "video" && mode !== "text") mode = "video";
        breakPair(socket, null);
        enqueue(socket, mode);

        // Save topics (normalize lowercase)
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

    // ✅ Messages (with bad word check)
    socket.on("message", (msg) => {
        const lowerMsg = msg.toLowerCase();
        const partner = safePartner(socket.id);

        if (badWords.some((bw) => lowerMsg.includes(bw))) {
            socket.emit("bad-word-warning", { text: msg });
            if (partner) partner.emit("message", msg);
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
        topicsOf.delete(myId); // ✅ clean topics
    });

    socket.on("disconnect", () => {
        breakPair(socket, "partner-left");
        modeOf.delete(socket.id);
        countryOf.delete(socket.id);
        topicsOf.delete(socket.id);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log("✅ Signaling server listening on", PORT);
});
