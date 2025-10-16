import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  roomId: { type: String, required: true },
  senderIp: { type: String },
  receiverIp: { type: String },
  senderSocketId: { type: String },
  receiverSocketId: { type: String },
  text: { type: String },
  reported: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Message", messageSchema);
