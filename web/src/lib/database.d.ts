import { Participant, Match } from '../types';
export declare class Database {
    static createUser(username: string, passwordHash: string): Promise<number | null>;
    static getUserByUsername(username: string): Promise<any | null>;
    static getUserById(id: number): Promise<any | null>;
    static mergeGuestData(userId: number, guestSessionId: string): Promise<void>;
    static getPlayers(userId?: number | null, guestSessionId?: string | null): Promise<Participant[]>;
    static getMatchHistory(userId?: number | null, guestSessionId?: string): Promise<Match[]>;
    static saveTournament(mode: string, matches: Match[], userId?: number | null, guestSessionId?: string): Promise<void>;
    private static updateOverallStats;
    static getTournamentHistory(userId?: number | null, guestSessionId?: string): Promise<any[]>;
    static saveMatch(match: Match): Promise<void>;
    static addPlayer(name: string, userId?: number | null, guestSessionId?: string): Promise<Participant>;
}
//# sourceMappingURL=database.d.ts.map