import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const SALT_ROUNDS = 10;

function jwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
        throw new Error('JWT_SECRET must be configured with at least 32 bytes before legacy JWT utilities are used.');
    }
    return secret;
}

// The v2 application does not use JWTs. Fail closed if this legacy module is
// accidentally loaded by a production entry point with no strong secret.
if (process.env.NODE_ENV === 'production') jwtSecret();

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
        return jwt.sign(payload, jwtSecret(), { expiresIn: '7d' });
    }

    static verifyToken(token: string): any {
        try {
            return jwt.verify(token, jwtSecret());
        } catch (e) {
            return null;
        }
    }
}
