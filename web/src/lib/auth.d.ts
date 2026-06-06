export declare class AuthUtils {
    static hashPassword(password: string): Promise<string>;
    static comparePassword(password: string, hash: string): Promise<boolean>;
    static generateToken(userId: number, guestSessionId?: string): string;
    static verifyToken(token: string): any;
}
//# sourceMappingURL=auth.d.ts.map