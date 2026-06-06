import { Participant, Match, GameState } from '../types';
import { LocalDatabase } from './local-database';

declare const require: any;
declare const process: any;
declare const __dirname: string;

const path = require('path');

const databaseMode = (process.env.DB_MODE || 'postgres').toLowerCase();
const useLocalDatabase = databaseMode === 'local' || databaseMode === 'offline';
let postgresPool: any = null;

function getPostgresPool() {
    if (useLocalDatabase) {
        throw new Error('Postgres pool requested while offline mode is active');
    }

    if (!postgresPool) {
        const dotenv = require('dotenv');
        dotenv.config({ path: path.join(__dirname, '../../.env') });

        const connectionString = (process.env.POSTGRES_URL || '').replace('sslmode=require', 'sslmode=verify-full');
        const { Pool } = require('pg');
        postgresPool = new Pool({
            connectionString,
        });
    }

    return postgresPool;
}

export class Database {
    // --- User Authentication ---
    static async createUser(username: string, passwordHash: string): Promise<number | null> {
        if (useLocalDatabase) {
            return LocalDatabase.createUser(username, passwordHash);
        }
        const client = await getPostgresPool().connect();
        try {
            const res = await client.query(
                `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`,
                [username, passwordHash]
            );
            return res.rows[0].id;
        } catch (error) {
            console.error('Error creating user:', error);
            return null; // Could be duplicate username
        } finally {
            client.release();
        }
    }

    static async getUserByUsername(username: string): Promise<any | null> {
        if (useLocalDatabase) {
            return LocalDatabase.getUserByUsername(username);
        }
        const client = await getPostgresPool().connect();
        try {
            const res = await client.query(`SELECT * FROM users WHERE username = $1`, [username]);
            return res.rows.length > 0 ? res.rows[0] : null;
        } catch (error) {
            console.error('Error fetching user:', error);
            return null;
        } finally {
            client.release();
        }
    }

    static async getUserById(id: number): Promise<any | null> {
        if (useLocalDatabase) {
            return LocalDatabase.getUserById(id);
        }
        const client = await getPostgresPool().connect();
        try {
            const res = await client.query(`SELECT * FROM users WHERE id = $1`, [id]);
            return res.rows.length > 0 ? res.rows[0] : null;
        } catch (error) {
            console.error('Error fetching user by id:', error);
            return null;
        } finally {
            client.release();
        }
    }

    static async mergeGuestData(userId: number, guestSessionId: string) {
        if (useLocalDatabase) {
            return LocalDatabase.mergeGuestData(userId, guestSessionId);
        }
        const client = await getPostgresPool().connect();
        try {
            await client.query('BEGIN');
            
            // Transfer players, tournaments, and matches from guest session to the user.
            await client.query(`UPDATE players SET user_id = $1, guest_session_id = NULL WHERE guest_session_id = $2 AND user_id IS NULL`, [userId, guestSessionId]);
            await client.query(`UPDATE tournaments SET user_id = $1, guest_session_id = NULL WHERE guest_session_id = $2 AND user_id IS NULL`, [userId, guestSessionId]);
            await client.query(`UPDATE matches SET user_id = $1, guest_session_id = NULL WHERE guest_session_id = $2 AND user_id IS NULL`, [userId, guestSessionId]);
            
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error merging guest data:', error);
        } finally {
            client.release();
        }
    }

    static async getPlayers(userId: number | null = null, guestSessionId: string | null = null): Promise<Participant[]> {
        if (useLocalDatabase) {
            return LocalDatabase.getPlayers(userId, guestSessionId);
        }
        const client = await getPostgresPool().connect();
        try {
            let res;
            if (userId) {
                res = await client.query('SELECT * FROM players WHERE user_id = $1 ORDER BY id', [userId]);
            } else {
                res = await client.query('SELECT * FROM players WHERE guest_session_id = $1 ORDER BY id', [guestSessionId]);
            }
            return res.rows.map((row: any) => ({
                id: row.id.toString(),
                name: row.name,
                gamesPlayed: row.games_played || 0,
                wins: row.wins || 0,
                losses: row.losses || 0,
                draws: row.draws || 0,
                pointsFor: row.points_for || 0,
                pointsAgainst: row.points_against || 0,
                diff: row.diff || 0
            }));
        } catch (error) {
            console.error('Error reading players:', error);
            return [];
        } finally {
            client.release();
        }
    }

    static async getMatchHistory(userId: number | null = null, guestSessionId: string = 'default-guest'): Promise<Match[]> {
        if (useLocalDatabase) {
            return LocalDatabase.getMatchHistory(userId, guestSessionId);
        }
        const client = await getPostgresPool().connect();
        try {
            let res;
            if (userId) {
                res = await client.query('SELECT * FROM matches WHERE user_id = $1 ORDER BY id', [userId]);
            } else {
                res = await client.query('SELECT * FROM matches WHERE guest_session_id = $1 ORDER BY id', [guestSessionId]);
            }
            return res.rows.map((row: any) => {
                const match: Match = {
                    id: row.id.toString(),
                    teams: row.teams,
                };
                if (row.start_time) match.startTime = new Date(row.start_time).getTime();
                if (row.end_time) match.endTime = new Date(row.end_time).getTime();
                if (row.winner) match.winner = row.winner;
                return match;
            });
        } catch (error) {
            console.error('Error reading match history:', error);
            return [];
        } finally {
            client.release();
        }
    }

    static async saveTournament(mode: string, matches: Match[], userId: number | null = null, guestSessionId: string = 'default-guest') {
        if (useLocalDatabase) {
            return LocalDatabase.saveTournament(mode, matches, userId, guestSessionId);
        }
        const client = await getPostgresPool().connect();
        try {
            await client.query('BEGIN');

            const stats: Record<string, any> = {};
            matches.forEach(m => {
                const t1 = m.teams[0];
                const t2 = m.teams[1];
                if (!t1 || !t2) return;

                const score1 = t1.score || 0;
                const score2 = t2.score || 0;

                t1.participants.forEach(p => {
                    if (!stats[p.id]) stats[p.id] = { id: p.id, name: p.name, wins: 0, draws: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0, matchesPlayed: 0 };
                    stats[p.id].pointsFor += score1;
                    stats[p.id].pointsAgainst += score2;
                    stats[p.id].diff += (score1 - score2);
                    stats[p.id].matchesPlayed++;
                    if (score1 > score2) stats[p.id].wins++;
                    else if (score1 === score2) stats[p.id].draws++;
                    else stats[p.id].losses++;
                });

                t2.participants.forEach(p => {
                    if (!stats[p.id]) stats[p.id] = { id: p.id, name: p.name, wins: 0, draws: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0, matchesPlayed: 0 };
                    stats[p.id].pointsFor += score2;
                    stats[p.id].pointsAgainst += score1;
                    stats[p.id].diff += (score2 - score1);
                    stats[p.id].matchesPlayed++;
                    if (score2 > score1) stats[p.id].wins++;
                    else if (score2 === score1) stats[p.id].draws++;
                    else stats[p.id].losses++;
                });
            });

            const standings = Object.values(stats).sort((a, b) => {
                if (b.wins !== a.wins) return b.wins - a.wins;
                return b.diff - a.diff;
            });

            // Insert Tournament
            const tourResult = await client.query(
                `INSERT INTO tournaments (user_id, guest_session_id, mode, standings) VALUES ($1, $2, $3, $4) RETURNING id`,
                [userId, guestSessionId, mode, JSON.stringify(standings)]
            );
            const tournamentId = tourResult.rows[0].id;

            // Insert Matches
            for (const match of matches) {
                await client.query(
                    `INSERT INTO matches (tournament_id, user_id, guest_session_id, teams, start_time, end_time)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        tournamentId, userId, guestSessionId, JSON.stringify(match.teams), 
                        match.startTime ? new Date(match.startTime) : null,
                        match.endTime ? new Date(match.endTime) : null
                    ]
                );
            }

            // Update Players Overall Stats
            await this.updateOverallStats(client, standings);

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error saving tournament history:', error);
        } finally {
            client.release();
        }
    }

    private static async updateOverallStats(client: any, tournamentStandings: any[]) {
        for (const pStats of tournamentStandings) {
            await client.query(
                `UPDATE players 
                 SET games_played = games_played + $1,
                     wins = wins + $2,
                     losses = losses + $3,
                     draws = draws + $4,
                     points_for = points_for + $5,
                     points_against = points_against + $6,
                     diff = diff + $7
                 WHERE id = $8`,
                [
                    pStats.matchesPlayed, pStats.wins, pStats.losses, 
                    pStats.draws, pStats.pointsFor, pStats.pointsAgainst, 
                    pStats.diff, parseInt(pStats.id)
                ]
            );
        }
    }

    static async getTournamentHistory(userId: number | null = null, guestSessionId: string = 'default-guest'): Promise<any[]> {
        if (useLocalDatabase) {
            return LocalDatabase.getTournamentHistory(userId, guestSessionId);
        }
        const client = await getPostgresPool().connect();
        try {
            let res;
            if (userId) {
                res = await client.query('SELECT * FROM tournaments WHERE user_id = $1 ORDER BY date DESC', [userId]);
            } else {
                res = await client.query('SELECT * FROM tournaments WHERE guest_session_id = $1 ORDER BY date DESC', [guestSessionId]);
            }
            return res.rows.map((row: any) => ({
                id: row.id.toString(),
                date: row.date ? new Date(row.date).getTime() : undefined,
                mode: row.mode,
                standings: row.standings,
                matches: [] // Can be queried if needed
            }));
        } catch (error) {
            console.error('Error getting tournament history:', error);
            return [];
        } finally {
            client.release();
        }
    }

    static async saveMatch(match: Match) {
        // Implementation for writing match progress back
    }

    static async addPlayer(name: string, userId: number | null = null, guestSessionId: string = 'default-guest'): Promise<Participant> {
        if (useLocalDatabase) {
            return LocalDatabase.addPlayer(name, userId, guestSessionId);
        }
        const client = await getPostgresPool().connect();
        try {
            const normalizedName = name.trim().replace(/\s+/g, ' ').toLowerCase();
            const duplicateCheck = userId
                ? await client.query(
                    `SELECT id FROM players WHERE user_id = $1 AND LOWER(TRIM(name)) = $2 LIMIT 1`,
                    [userId, normalizedName]
                )
                : await client.query(
                    `SELECT id FROM players WHERE guest_session_id = $1 AND LOWER(TRIM(name)) = $2 LIMIT 1`,
                    [guestSessionId, normalizedName]
                );

            if (duplicateCheck.rows.length > 0) {
                const duplicateError = new Error('Duplicate player name');
                duplicateError.name = 'DuplicatePlayerNameError';
                throw duplicateError;
            }

            const res = await client.query(
                `INSERT INTO players (user_id, guest_session_id, name) VALUES ($1, $2, $3) RETURNING id, name`,
                [userId, guestSessionId, name]
            );
            return { id: res.rows[0].id.toString(), name: res.rows[0].name };
        } catch (error) {
            console.error('Error adding player:', error);
            throw error;
        } finally {
            client.release();
        }
    }
}