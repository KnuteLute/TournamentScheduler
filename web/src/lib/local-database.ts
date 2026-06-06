import { Participant, Match } from '../types';

declare const require: any;
declare const __dirname: string;

const fs = require('fs');
const path = require('path');

interface LocalPlayerRecord {
    id: number;
    user_id: number | null;
    guest_session_id: string | null;
    name: string;
    games_played: number;
    wins: number;
    losses: number;
    draws: number;
    points_for: number;
    points_against: number;
    diff: number;
    created_at: string;
}

interface LocalUserRecord {
    id: number;
    username: string;
    password_hash: string;
    created_at: string;
}

interface LocalTournamentRecord {
    id: number;
    user_id: number | null;
    guest_session_id: string | null;
    mode: string;
    date: string;
    standings: any;
}

interface LocalMatchRecord {
    id: number;
    tournament_id: number;
    user_id: number | null;
    guest_session_id: string | null;
    teams: any;
    start_time: string | null;
    end_time: string | null;
}

interface LocalDatabaseState {
    nextIds: {
        users: number;
        players: number;
        tournaments: number;
        matches: number;
    };
    users: LocalUserRecord[];
    players: LocalPlayerRecord[];
    tournaments: LocalTournamentRecord[];
    matches: LocalMatchRecord[];
}

const DATA_DIR = path.join(__dirname, '../../.local-data');
const DATA_FILE = path.join(DATA_DIR, 'offline-db.json');

const DEFAULT_STATE: LocalDatabaseState = {
    nextIds: {
        users: 1,
        players: 1,
        tournaments: 1,
        matches: 1
    },
    users: [],
    players: [],
    tournaments: [],
    matches: []
};

function normalizeName(name: string) {
    return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function cloneState(state: LocalDatabaseState): LocalDatabaseState {
    return JSON.parse(JSON.stringify(state));
}

function ensureStateFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_STATE, null, 2), 'utf-8');
    }
}

function readState(): LocalDatabaseState {
    ensureStateFile();
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<LocalDatabaseState>;
        return {
            nextIds: {
                users: parsed.nextIds?.users || DEFAULT_STATE.nextIds.users,
                players: parsed.nextIds?.players || DEFAULT_STATE.nextIds.players,
                tournaments: parsed.nextIds?.tournaments || DEFAULT_STATE.nextIds.tournaments,
                matches: parsed.nextIds?.matches || DEFAULT_STATE.nextIds.matches
            },
            users: parsed.users || [],
            players: parsed.players || [],
            tournaments: parsed.tournaments || [],
            matches: parsed.matches || []
        };
    } catch (error) {
        console.error('Error reading local database state:', error);
        return cloneState(DEFAULT_STATE);
    }
}

function writeState(state: LocalDatabaseState) {
    ensureStateFile();
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function participantFromPlayer(player: LocalPlayerRecord): any {
    return {
        id: player.id.toString(),
        name: player.name,
        gamesPlayed: player.games_played || 0,
        wins: player.wins || 0,
        losses: player.losses || 0,
        draws: player.draws || 0,
        pointsFor: player.points_for || 0,
        pointsAgainst: player.points_against || 0,
        diff: player.diff || 0
    };
}

function matchesScope(player: LocalPlayerRecord, userId: number | null, guestSessionId: string | null) {
    if (userId !== null && userId !== undefined) {
        return player.user_id === userId;
    }
    return player.user_id === null && player.guest_session_id === guestSessionId;
}

function tournamentsScope(tournament: LocalTournamentRecord, userId: number | null, guestSessionId: string | null) {
    if (userId !== null && userId !== undefined) {
        return tournament.user_id === userId;
    }
    return tournament.user_id === null && tournament.guest_session_id === guestSessionId;
}

function matchesScopeRecord(match: LocalMatchRecord, userId: number | null, guestSessionId: string | null) {
    if (userId !== null && userId !== undefined) {
        return match.user_id === userId;
    }
    return match.user_id === null && match.guest_session_id === guestSessionId;
}

export class LocalDatabase {
    static async createUser(username: string, passwordHash: string): Promise<number | null> {
        const state = readState();
        if (state.users.some(user => user.username === username)) {
            return null;
        }

        const id = state.nextIds.users++;
        state.users.push({
            id,
            username,
            password_hash: passwordHash,
            created_at: new Date().toISOString()
        });
        writeState(state);
        return id;
    }

    static async getUserByUsername(username: string): Promise<any | null> {
        const state = readState();
        return state.users.find(user => user.username === username) || null;
    }

    static async getUserById(id: number): Promise<any | null> {
        const state = readState();
        return state.users.find(user => user.id === id) || null;
    }

    static async mergeGuestData(userId: number, guestSessionId: string) {
        const state = readState();
        state.players.forEach(player => {
            if (player.guest_session_id === guestSessionId && player.user_id === null) {
                player.user_id = userId;
                player.guest_session_id = null;
            }
        });
        state.tournaments.forEach(tournament => {
            if (tournament.guest_session_id === guestSessionId && tournament.user_id === null) {
                tournament.user_id = userId;
                tournament.guest_session_id = null;
            }
        });
        state.matches.forEach(match => {
            if (match.guest_session_id === guestSessionId && match.user_id === null) {
                match.user_id = userId;
                match.guest_session_id = null;
            }
        });
        writeState(state);
    }

    static async getPlayers(userId: number | null = null, guestSessionId: string | null = null): Promise<Participant[]> {
        const state = readState();
        return state.players
            .filter(player => matchesScope(player, userId, guestSessionId))
            .sort((a, b) => a.id - b.id)
            .map(player => participantFromPlayer(player));
    }

    static async getMatchHistory(userId: number | null = null, guestSessionId: string = 'default-guest'): Promise<Match[]> {
        const state = readState();
        return state.matches
            .filter(match => matchesScopeRecord(match, userId, guestSessionId))
            .sort((a, b) => a.id - b.id)
            .map(match => {
                const output: Match = {
                    id: match.id.toString(),
                    teams: match.teams
                };
                if (match.start_time) output.startTime = new Date(match.start_time).getTime();
                if (match.end_time) output.endTime = new Date(match.end_time).getTime();
                return output;
            });
    }

    static async saveTournament(mode: string, matches: Match[], userId: number | null = null, guestSessionId: string = 'default-guest') {
        const state = readState();

        const stats: Record<string, any> = {};
        matches.forEach(match => {
            const team1 = match.teams[0];
            const team2 = match.teams[1];
            if (!team1 || !team2) return;

            const score1 = team1.score || 0;
            const score2 = team2.score || 0;

            team1.participants.forEach(participant => {
                if (!stats[participant.id]) {
                    stats[participant.id] = { id: participant.id, name: participant.name, wins: 0, draws: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0, matchesPlayed: 0 };
                }
                stats[participant.id].pointsFor += score1;
                stats[participant.id].pointsAgainst += score2;
                stats[participant.id].diff += (score1 - score2);
                stats[participant.id].matchesPlayed++;
                if (score1 > score2) stats[participant.id].wins++;
                else if (score1 === score2) stats[participant.id].draws++;
                else stats[participant.id].losses++;
            });

            team2.participants.forEach(participant => {
                if (!stats[participant.id]) {
                    stats[participant.id] = { id: participant.id, name: participant.name, wins: 0, draws: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0, matchesPlayed: 0 };
                }
                stats[participant.id].pointsFor += score2;
                stats[participant.id].pointsAgainst += score1;
                stats[participant.id].diff += (score2 - score1);
                stats[participant.id].matchesPlayed++;
                if (score2 > score1) stats[participant.id].wins++;
                else if (score2 === score1) stats[participant.id].draws++;
                else stats[participant.id].losses++;
            });
        });

        const standings = Object.values(stats).sort((a: any, b: any) => {
            if (b.wins !== a.wins) return b.wins - a.wins;
            return b.diff - a.diff;
        });

        const tournamentId = state.nextIds.tournaments++;
        state.tournaments.push({
            id: tournamentId,
            user_id: userId,
            guest_session_id: guestSessionId,
            mode,
            date: new Date().toISOString(),
            standings
        });

        for (const match of matches) {
            state.matches.push({
                id: state.nextIds.matches++,
                tournament_id: tournamentId,
                user_id: userId,
                guest_session_id: guestSessionId,
                teams: match.teams,
                start_time: match.startTime ? new Date(match.startTime).toISOString() : null,
                end_time: match.endTime ? new Date(match.endTime).toISOString() : null
            });
        }

        state.players.forEach(player => {
            const statsRow = stats[player.id.toString()];
            if (!statsRow) return;
            player.games_played += statsRow.matchesPlayed;
            player.wins += statsRow.wins;
            player.losses += statsRow.losses;
            player.draws += statsRow.draws;
            player.points_for += statsRow.pointsFor;
            player.points_against += statsRow.pointsAgainst;
            player.diff += statsRow.diff;
        });

        writeState(state);
    }

    static async getTournamentHistory(userId: number | null = null, guestSessionId: string = 'default-guest'): Promise<any[]> {
        const state = readState();
        return state.tournaments
            .filter(tournament => tournamentsScope(tournament, userId, guestSessionId))
            .sort((a, b) => b.id - a.id)
            .map(tournament => ({
                id: tournament.id.toString(),
                date: tournament.date ? new Date(tournament.date).getTime() : undefined,
                mode: tournament.mode,
                standings: tournament.standings,
                matches: []
            }));
    }

    static async saveMatch(match: Match) {
        return;
    }

    static async addPlayer(name: string, userId: number | null = null, guestSessionId: string = 'default-guest'): Promise<Participant> {
        const state = readState();
        const normalizedName = normalizeName(name);

        const duplicateExists = state.players.some(player => {
            if (!matchesScope(player, userId, guestSessionId)) return false;
            return normalizeName(player.name) === normalizedName;
        });

        if (duplicateExists) {
            const duplicateError = new Error('Duplicate player name');
            duplicateError.name = 'DuplicatePlayerNameError';
            throw duplicateError;
        }

        const id = state.nextIds.players++;
        state.players.push({
            id,
            user_id: userId,
            guest_session_id: guestSessionId,
            name,
            games_played: 0,
            wins: 0,
            losses: 0,
            draws: 0,
            points_for: 0,
            points_against: 0,
            diff: 0,
            created_at: new Date().toISOString()
        });
        writeState(state);
        return { id: id.toString(), name };
    }
}
