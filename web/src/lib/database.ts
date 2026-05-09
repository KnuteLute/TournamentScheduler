import fs from 'fs';
import path from 'path';
import { Participant, Match, GameState } from '../types';

const DATABASE_DIR = path.join(__dirname, '../../database');

export class Database {
    private static getFilePath(filename: string) {
        return path.join(DATABASE_DIR, filename);
    }

    static async getPlayers(): Promise<Participant[]> {
        const filePath = this.getFilePath('players_index.json');
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const players = JSON.parse(data);
            // Convert existing format to our Participant interface
            return Object.entries(players).map(([id, name]) => ({
                id,
                name: name as string
            }));
        } catch (error) {
            console.error('Error reading players:', error);
            return [];
        }
    }

    static async getMatchHistory(): Promise<Match[]> {
        const filePath = this.getFilePath('match_history.json');
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error reading match history:', error);
            return [];
        }
    }

    static async saveTournament(mode: string, matches: Match[]) {
        const filePath = this.getFilePath('tournament_history.json');
        try {
            let history: any[] = [];
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf8');
                if (data.trim()) {
                    history = JSON.parse(data);
                }
            }
            
            // Calculate standings (stats) for this specific tournament
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

            // Convert stats object to sorted array
            const standings = Object.values(stats).sort((a, b) => {
                if (b.wins !== a.wins) return b.wins - a.wins;
                return b.diff - a.diff;
            });

            const tournament = {
                id: Date.now().toString(),
                date: Date.now(),
                mode: mode,
                matches: matches.map(m => ({ ...m, endTime: m.endTime || Date.now() })),
                standings: standings
            };
            
            history.push(tournament);
            fs.writeFileSync(filePath, JSON.stringify(history, null, 4));

            // Update overall player stats for leaderboard
            await this.updateOverallStats(standings);

        } catch (error) {
            console.error('Error saving tournament history:', error);
        }
    }

    private static async updateOverallStats(tournamentStandings: any[]) {
        const playerDir = path.join(DATABASE_DIR, 'players');
        if (!fs.existsSync(playerDir)) fs.mkdirSync(playerDir);

        for (const pStats of tournamentStandings) {
            try {
                const statsFile = path.join(playerDir, `${pStats.id}.json`);
                let overall = { name: pStats.name, gamesPlayed: 0, wins: 0, losses: 0, draws: 0, winRate: 0, pointsFor: 0, pointsAgainst: 0, diff: 0 };
                
                if (fs.existsSync(statsFile)) {
                    const data = fs.readFileSync(statsFile, 'utf8');
                    overall = { ...overall, ...JSON.parse(data) };
                }

                overall.gamesPlayed += pStats.matchesPlayed;
                overall.wins += pStats.wins;
                overall.losses += pStats.losses;
                overall.draws = (overall.draws || 0) + pStats.draws;
                overall.pointsFor = (overall.pointsFor || 0) + pStats.pointsFor;
                overall.pointsAgainst = (overall.pointsAgainst || 0) + pStats.pointsAgainst;
                overall.diff = (overall.diff || 0) + pStats.diff;
                overall.winRate = overall.gamesPlayed > 0 ? Math.round((overall.wins / overall.gamesPlayed) * 100) : 0;

                fs.writeFileSync(statsFile, JSON.stringify(overall, null, 4));
            } catch (e) {
                console.error(`Failed to update overall stats for player ${pStats.id}`, e);
            }
        }
    }

    static async getTournamentHistory(): Promise<any[]> {
        const filePath = this.getFilePath('tournament_history.json');
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return [];
        }
    }

    static async saveMatch(match: Match) {
        // Implementation for later: writing back to JSON
    }

    static async addPlayer(name: string): Promise<Participant> {
        const indexFilePath = this.getFilePath('players_index.json');
        try {
            const data = fs.readFileSync(indexFilePath, 'utf8');
            const players = JSON.parse(data);
            
            const nextId = (Object.keys(players).length + 1).toString();
            players[nextId] = name;
            
            fs.writeFileSync(indexFilePath, JSON.stringify(players, null, 4));
            
            const playerDir = path.join(DATABASE_DIR, 'players');
            if (!fs.existsSync(playerDir)) fs.mkdirSync(playerDir);
            
            const playerStatsFile = path.join(playerDir, `${nextId}.json`);
            fs.writeFileSync(playerStatsFile, JSON.stringify({
                name: name,
                gamesPlayed: 0,
                wins: 0,
                losses: 0,
                winRate: 0
            }, null, 4));

            return { id: nextId, name };
        } catch (error) {
            console.error('Error adding player:', error);
            throw error;
        }
    }
}
