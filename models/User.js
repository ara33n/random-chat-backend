import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    googleId: { type: String, index: true, unique: true },
    email: { type: String, index: true },
    name: { type: String },
    picture: { type: String },
    loginCount: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
});

const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
