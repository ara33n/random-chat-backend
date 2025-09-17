// models/Payment.js
import mongoose from "mongoose";

const PaymentSchema = new mongoose.Schema(
    {
        orderId: { type: String, required: true, unique: true },
        amount: Number,
        currency: String,
        payCurrency: String,
        paymentStatus: { type: String, default: "waiting" }, // waiting, confirmed, failed
        paymentId: String, // NOWPayments payment id
        txHash: String, // transaction hash from NOWPayments
        raw: Object,
    },
    { timestamps: true }
);

export default mongoose.model("Payment", PaymentSchema);
