import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema(
    {
        roomId: { type: String, index: true },
        text: String,
        senderIp: String,
        receiverIp: String,
        senderSocketId: String,
        receiverSocketId: String,
        flagged: { type: Boolean, default: false },
        reported: { type: Boolean, default: false },
    },
    { timestamps: true }
);

export default mongoose.model("Message", MessageSchema);
