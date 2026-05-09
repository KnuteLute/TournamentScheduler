"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const express_ejs_layouts_1 = __importDefault(require("express-ejs-layouts"));
const database_1 = require("./lib/database");
const scheduler_1 = require("./lib/scheduler");
const app = (0, express_1.default)();
const DEFAULT_PORT = 3000;
app.set('view engine', 'ejs');
app.set('views', path_1.default.join(__dirname, '../views'));
app.use(express_ejs_layouts_1.default);
app.set('layout', 'layout');
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.get('/', async (req, res) => {
    const players = await database_1.Database.getPlayers();
    res.render('home', {
        title: 'Shuffle Tournament',
        players: players,
    });
});
app.get('/play', async (req, res) => {
    res.render('play', {
        title: 'New Game',
    });
});
app.get('/play/:mode', async (req, res) => {
    const { mode } = req.params;
    const { error } = req.query;
    const players = await database_1.Database.getPlayers();
    res.render('team_selection', {
        title: `Select Players for ${mode}`,
        mode: mode,
        players: players,
        error: error
    });
});
app.post('/players/add', async (req, res) => {
    const { name, mode } = req.body;
    if (name && name.trim()) {
        try {
            await database_1.Database.addPlayer(name.trim());
        }
        catch (e) {
            console.error(e);
        }
    }
    res.redirect(`/play/${mode}`);
});
app.get('/history', async (req, res) => {
    const tournaments = await database_1.Database.getTournamentHistory();
    res.render('history', {
        title: 'Turneringshistorikk',
        tournaments: tournaments.reverse() // show newest first
    });
});
app.get('/history/:id', async (req, res) => {
    const tournaments = await database_1.Database.getTournamentHistory();
    const tournament = tournaments.find(t => t.id === req.params.id);
    if (!tournament)
        return res.redirect('/history');
    res.render('history_detail', {
        title: `Turnering Detaljer`,
        tournament: tournament
    });
});
app.get('/leaderboard', async (req, res) => {
    const allPlayers = await database_1.Database.getPlayers();
    const playerDir = path_1.default.join(__dirname, '../database/players');
    let leaderboard = [];
    for (const p of allPlayers) {
        try {
            const statFile = path_1.default.join(playerDir, `${p.id}.json`);
            if (fs_1.default.existsSync(statFile)) {
                const stats = JSON.parse(fs_1.default.readFileSync(statFile, 'utf8'));
                leaderboard.push(stats);
            }
        }
        catch (e) { }
    }
    leaderboard.sort((a, b) => b.wins - a.wins || b.diff - a.diff);
    res.render('leaderboard', {
        title: 'Ledertavle (Overall)',
        leaderboard: leaderboard
    });
});
const server = app.listen(DEFAULT_PORT, () => {
    console.log(`Server is running on http://localhost:${DEFAULT_PORT}`);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`Port ${DEFAULT_PORT} is busy, trying ${DEFAULT_PORT + 1}...`);
        app.listen(DEFAULT_PORT + 1);
    }
    else {
        console.error(err);
    }
});
let tournamentState = {
    mode: '',
    matches: [],
    participants: [],
    pausedPlayerIds: [],
    currentMatchIndex: 0
};
app.post('/play/:mode/start', async (req, res) => {
    const { mode } = req.params;
    let playerIds = req.body.playerIds;
    if (!playerIds || (Array.isArray(playerIds) && playerIds.length === 0)) {
        return res.redirect(`/play/${mode}?error=Please select players`);
    }
    if (!Array.isArray(playerIds)) {
        playerIds = [playerIds];
    }
    const allPlayers = await database_1.Database.getPlayers();
    const participants = playerIds.map((id) => {
        const found = allPlayers.find(p => p.id === id);
        return found ? found : { id, name: id };
    });
    tournamentState.mode = mode;
    tournamentState.currentMatchIndex = 0;
    tournamentState.participants = participants;
    tournamentState.pausedPlayerIds = [];
    if (mode === '1v1') {
        tournamentState.matches = (0, scheduler_1.generate1v1Matches)(participants);
    }
    else if (mode === '2v2-rotating') {
        if (participants.length < 3) {
            return res.redirect(`/play/${mode}?error=Need at least 3 players for Rotating 2v2`);
        }
        tournamentState.matches = [];
        const initialMatch = (0, scheduler_1.generateNextDynamic2v2Match)([], participants, []);
        if (initialMatch)
            tournamentState.matches.push(initialMatch);
    }
    else if (mode === '2v2-fixed') {
        if (participants.length < 4) {
            return res.redirect(`/play/${mode}?error=Need at least 4 players for Fixed 2v2 (creates 2 teams)`);
        }
        tournamentState.matches = (0, scheduler_1.generateFixed2v2Matches)(participants);
    }
    res.redirect('/tournament/active');
});
app.get('/tournament/active', (req, res) => {
    if (tournamentState.matches.length === 0) {
        return res.redirect('/play?error=No active tournament');
    }
    res.render('game_play', {
        title: `Game ${tournamentState.mode}`,
        match: tournamentState.matches[tournamentState.currentMatchIndex],
        currentIndex: tournamentState.currentMatchIndex,
        totalMatches: tournamentState.matches.length,
        mode: tournamentState.mode,
        participants: tournamentState.participants,
        pausedPlayerIds: tournamentState.pausedPlayerIds
    });
});
app.post('/tournament/score', (req, res) => {
    const { score1, score2, action } = req.body;
    const currentMatch = tournamentState.matches[tournamentState.currentMatchIndex];
    if (currentMatch && currentMatch.teams && currentMatch.teams.length >= 2) {
        const team1 = currentMatch.teams[0];
        const team2 = currentMatch.teams[1];
        if (team1)
            team1.score = parseInt(score1 || '0', 10);
        if (team2)
            team2.score = parseInt(score2 || '0', 10);
    }
    if (action === 'prev') {
        res.redirect('/tournament/prev');
    }
    else if (action === 'next') {
        res.redirect('/tournament/next');
    }
    else if (action === 'skip') {
        tournamentState.matches.splice(tournamentState.currentMatchIndex, 1);
        if (tournamentState.mode === '2v2-rotating') {
            const nextMatch = (0, scheduler_1.generateNextDynamic2v2Match)(tournamentState.matches, tournamentState.participants, tournamentState.pausedPlayerIds);
            if (nextMatch)
                tournamentState.matches.push(nextMatch);
            else if (tournamentState.matches.length === 0)
                return res.redirect('/tournament/finish');
        }
        if (tournamentState.currentMatchIndex >= tournamentState.matches.length) {
            tournamentState.currentMatchIndex = Math.max(0, tournamentState.matches.length - 1);
        }
        res.redirect('/tournament/active');
    }
    else if (action === 'finish') {
        res.redirect(307, '/tournament/finish');
    }
    else {
        res.redirect('/tournament/active');
    }
});
app.get('/tournament/next', (req, res) => {
    if (tournamentState.currentMatchIndex < tournamentState.matches.length - 1) {
        tournamentState.currentMatchIndex++;
    }
    else if (tournamentState.mode === '2v2-rotating') {
        const nextMatch = (0, scheduler_1.generateNextDynamic2v2Match)(tournamentState.matches, tournamentState.participants, tournamentState.pausedPlayerIds);
        if (nextMatch) {
            tournamentState.matches.push(nextMatch);
            tournamentState.currentMatchIndex++;
        }
    }
    res.redirect('/tournament/active');
});
app.get('/tournament/prev', (req, res) => {
    if (tournamentState.currentMatchIndex > 0) {
        tournamentState.currentMatchIndex--;
    }
    res.redirect('/tournament/active');
});
app.post('/tournament/toggle_pause', (req, res) => {
    const pausedIds = req.body.pausedIds || [];
    tournamentState.pausedPlayerIds = Array.isArray(pausedIds) ? pausedIds : [pausedIds];
    res.redirect('/tournament/active');
});
app.post('/tournament/finish', async (req, res) => {
    if (tournamentState.matches.length > 0) {
        await database_1.Database.saveTournament(tournamentState.mode, tournamentState.matches);
    }
    tournamentState.matches = [];
    tournamentState.currentMatchIndex = 0;
    res.redirect('/history');
});
//# sourceMappingURL=app.js.map