export interface Participant {
    id: string;
    name: string;
}
export interface Team {
    id: string;
    participants: Participant[];
    score: number;
}
export interface Match {
    id: string;
    teams: Team[];
    startTime?: number;
    endTime?: number;
    winner?: string;
}
export type GameMode = '1v1' | '2v2_fixed' | '2v2_rotating';
export interface GameState {
    currentGameNumber: number;
    activeMode: GameMode;
    players: Participant[];
    matches: Match[];
}
//# sourceMappingURL=index.d.ts.map