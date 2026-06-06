"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthUtils = void 0;
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const SALT_ROUNDS = 10;
// In production, always use a real secret from env variables
const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-key-do-not-use-in-prod';
class AuthUtils {
    static async hashPassword(password) {
        return bcrypt_1.default.hash(password, SALT_ROUNDS);
    }
    static async comparePassword(password, hash) {
        return bcrypt_1.default.compare(password, hash);
    }
    static generateToken(userId, guestSessionId) {
        const payload = { userId };
        if (guestSessionId) {
            payload.guestSessionId = guestSessionId;
        }
        return jsonwebtoken_1.default.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    }
    static verifyToken(token) {
        try {
            return jsonwebtoken_1.default.verify(token, JWT_SECRET);
        }
        catch (e) {
            return null;
        }
    }
}
exports.AuthUtils = AuthUtils;
//# sourceMappingURL=auth.js.map