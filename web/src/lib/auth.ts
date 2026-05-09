import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const SALT_ROUNDS = 10;
// In production, always use a real secret from env variables
const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-key-do-not-use-in-prod';

export class AuthUtils {
    static async hashPassword(password: string): Promise<string> {
        return bcrypt.hash(password, SALT_ROUNDS);
    }

    static async comparePassword(password: string, hash: string): Promise<boolean> {
        return bcrypt.compare(password, hash);
    }

    static generateToken(userId: number, guestSessionId?: string): string {
        const payload: any = { userId };
        if (guestSessionId) {
            payload.guestSessionId = guestSessionId;
        }
        return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    }

    static verifyToken(token: string): any {
        try {
            return jwt.verify(token, JWT_SECRET);
        } catch (e) {
            return null;
        }
    }
}
