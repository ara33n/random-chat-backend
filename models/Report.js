import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
  reporterIp: { type: String, required: true },
  accusedIp: { type: String, required: true },
  reason: { type: String },
  messages: [
    {
      text: String,
      senderIp: String,
      receiverIp: String,
      senderSocketId: String,
      receiverSocketId: String,
      createdAt: Date,
    },
  ],
  status: { type: String, default: "pending" }, // pending, reviewed, banned
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Report", reportSchema);
