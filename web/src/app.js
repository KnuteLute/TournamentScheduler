"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const express_ejs_layouts_1 = __importDefault(require("express-ejs-layouts"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const database_1 = require("./lib/database");
const auth_1 = require("./lib/auth");
const crypto_1 = require("crypto");
const scheduler_1 = require("./lib/scheduler");
const app = (0, express_1.default)();
const DEFAULT_PORT = 3000;
const MODE_LABELS = {
    '1v1': '1 mot 1',
    '2v2-fixed': '2 mot 2 - faste lag',
    '2v2-rotating': '2 mot 2'
};
function getModeLabel(mode) {
    return MODE_LABELS[mode] || mode;
}
function normalizePlayerName(name) {
    return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('nb-NO');
}
function buildNextMatchPreview(mode, matches, currentMatchIndex, participants, pausedPlayerIds) {
    if (currentMatchIndex < matches.length - 1) {
        return matches[currentMatchIndex + 1] || null;
    }
    if (mode === '2v2-rotating') {
        return (0, scheduler_1.generateNextDynamic2v2Match)(matches.slice(0, currentMatchIndex + 1), participants, pausedPlayerIds);
    }
    return null;
}
app.set('view engine', 'ejs');
app.set('views', path_1.default.join(__dirname, '../views'));
app.use(express_ejs_layouts_1.default);
app.set('layout', 'layout');
app.use(express_1.default.static(path_1.default.join(__dirname, '../public'), {
    maxAge: '1y',
    immutable: true
}));
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cookie_parser_1.default)());
// --- Authentication Middleware ---
app.use(async (req, res, next) => {
    res.locals.user = null; // Default to no user for templates
    res.locals.guestSessionId = null;
    // Handle Auth Cookie
    const token = req.cookies.token;
    if (token) {
        const decoded = auth_1.AuthUtils.verifyToken(token);
        if (decoded && decoded.userId) {
            const user = await database_1.Database.getUserById(decoded.userId);
            if (user) {
                res.locals.user = { id: user.id, username: user.username };
            }
        }
    }
    // Handle Guest Session Cookie if not authenticated
    if (!res.locals.user) {
        let guestSession = req.cookies.guest_session;
        if (!guestSession) {
            guestSession = (0, crypto_1.randomUUID)();
            res.cookie('guest_session', guestSession, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }); // 1 day
        }
        res.locals.guestSessionId = guestSession;
    }
    next();
});
// --- Auth Routes ---
app.get('/login', (req, res) => {
    res.render('login', { title: 'Logg inn', hideHeader: true, error: null });
});
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await database_1.Database.getUserByUsername(username);
    if (!user) {
        return res.render('login', { title: 'Logg inn', hideHeader: true, error: 'Feil brukernavn eller passord.' });
    }
    const isMatch = await auth_1.AuthUtils.comparePassword(password, user.password_hash);
    if (!isMatch) {
        return res.render('login', { title: 'Logg inn', hideHeader: true, error: 'Feil brukernavn eller passord.' });
    }
    const token = auth_1.AuthUtils.generateToken(user.id);
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 });
    // Merge guest data
    const guestSession = req.cookies.guest_session;
    if (guestSession) {
        await database_1.Database.mergeGuestData(user.id, guestSession);
        res.clearCookie('guest_session');
    }
    res.redirect('/');
});
app.get('/signup', (req, res) => {
    res.render('signup', { title: 'Registrer deg', hideHeader: true, error: null });
});
app.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    if (password.length < 6) {
        return res.render('signup', { title: 'Registrer deg', hideHeader: true, error: 'Passordet må være minst 6 tegn langt.' });
    }
    const hash = await auth_1.AuthUtils.hashPassword(password);
    const userId = await database_1.Database.createUser(username, hash);
    if (!userId) {
        return res.render('signup', { title: 'Registrer deg', hideHeader: true, error: 'Brukernavnet er allerede i bruk.' });
    }
    const token = auth_1.AuthUtils.generateToken(userId);
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 });
    // Merge guest data
    const guestSession = req.cookies.guest_session;
    if (guestSession) {
        await database_1.Database.mergeGuestData(userId, guestSession);
        res.clearCookie('guest_session');
    }
    res.redirect('/');
});
app.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.redirect('/');
});
app.get('/', async (req, res) => {
    const players = await database_1.Database.getPlayers(res.locals.user?.id || null, res.locals.guestSessionId);
    res.render('home', {
        title: 'Shuffleboardturnering',
        players: players,
    });
});
app.get('/play', async (req, res) => {
    res.render('play', {
        title: 'Ny kamp',
    });
});
app.get('/play/:mode', async (req, res) => {
    const { mode } = req.params;
    const { error } = req.query;
    const players = await database_1.Database.getPlayers(res.locals.user?.id || null, res.locals.guestSessionId);
    res.render('team_selection', {
        title: `Velg spillere for ${getModeLabel(mode)}`,
        mode: mode,
        players: players,
        error: error
    });
});
app.post('/players/add', async (req, res) => {
    const { name, mode } = req.body;
    if (name && name.trim()) {
        try {
            const normalizedName = normalizePlayerName(name);
            const existingPlayers = await database_1.Database.getPlayers(res.locals.user?.id || null, res.locals.guestSessionId);
            if (existingPlayers.some(player => normalizePlayerName(player.name) === normalizedName)) {
                return res.redirect(`/play/${mode}?error=Spilleren finnes allerede. Bruk et annet navn.`);
            }
            await database_1.Database.addPlayer(name.trim(), res.locals.user?.id || null, res.locals.guestSessionId);
        }
        catch (e) {
            console.error(e);
        }
    }
    res.redirect(`/play/${mode}`);
});
app.post('/api/players/add', async (req, res) => {
    const { name } = req.body;
    if (name && name.trim()) {
        try {
            const normalizedName = normalizePlayerName(name);
            const existingPlayers = await database_1.Database.getPlayers(res.locals.user?.id || null, res.locals.guestSessionId);
            if (existingPlayers.some(player => normalizePlayerName(player.name) === normalizedName)) {
                return res.status(409).json({ error: 'Spilleren finnes allerede. Bruk et annet navn.' });
            }
            const player = await database_1.Database.addPlayer(name.trim(), res.locals.user?.id || null, res.locals.guestSessionId);
            return res.json({ success: true, player });
        }
        catch (e) {
            console.error(e);
            return res.status(500).json({ error: 'Kunne ikke legge til spiller.' });
        }
    }
    return res.status(400).json({ error: 'Ugyldig navn.' });
});
app.get('/history', async (req, res) => {
    const tournaments = await database_1.Database.getTournamentHistory(res.locals.user?.id || null, res.locals.guestSessionId);
    res.render('history', {
        title: 'Turneringshistorikk',
        tournaments: tournaments.reverse() // show newest first
    });
});
app.get('/history/:id', async (req, res) => {
    const tournaments = await database_1.Database.getTournamentHistory(res.locals.user?.id || null, res.locals.guestSessionId);
    const tournament = tournaments.find(t => t.id === req.params.id);
    if (!tournament)
        return res.redirect('/history');
    res.render('history_detail', {
        title: 'Turneringsdetaljer',
        tournament: tournament
    });
});
app.get('/leaderboard', async (req, res) => {
    const allPlayers = await database_1.Database.getPlayers(res.locals.user?.id || null, res.locals.guestSessionId);
    let leaderboard = allPlayers;
    leaderboard.sort((a, b) => b.wins - a.wins || b.diff - a.diff);
    res.render('leaderboard', {
        title: 'Ledertavle',
        leaderboard: leaderboard
    });
});
if (process.env.NODE_ENV !== 'production') {
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
}
// Export the app for Vercel Serverless environment
exports.default = app;
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
        return res.redirect(`/play/${mode}?error=Velg minst spillere.`);
    }
    if (!Array.isArray(playerIds)) {
        playerIds = [playerIds];
    }
    const allPlayers = await database_1.Database.getPlayers(res.locals.user?.id || null, res.locals.guestSessionId);
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
        if (participants.length < 4) {
            return res.redirect(`/play/${mode}?error=Du trenger minst 4 spillere for 2 mot 2.`);
        }
        tournamentState.matches = [];
        const initialMatch = (0, scheduler_1.generateNextDynamic2v2Match)([], participants, []);
        if (initialMatch)
            tournamentState.matches.push(initialMatch);
    }
    else if (mode === '2v2-fixed') {
        if (participants.length < 4) {
            return res.redirect(`/play/${mode}?error=Du trenger minst 4 spillere for faste 2 mot 2.`);
        }
        tournamentState.matches = (0, scheduler_1.generateFixed2v2Matches)(participants);
    }
    res.redirect('/tournament/active');
});
app.get('/tournament/active', (req, res) => {
    if (tournamentState.matches.length === 0) {
        return res.redirect('/play?error=Ingen aktiv turnering.');
    }
    const currentMatch = tournamentState.matches[tournamentState.currentMatchIndex];
    const nextMatchPreview = buildNextMatchPreview(tournamentState.mode, tournamentState.matches, tournamentState.currentMatchIndex, tournamentState.participants, tournamentState.pausedPlayerIds);
    res.render('game_play', {
        title: 'Kamp',
        hideHeader: true,
        match: currentMatch,
        currentIndex: tournamentState.currentMatchIndex,
        totalMatches: tournamentState.matches.length,
        mode: tournamentState.mode,
        participants: tournamentState.participants,
        pausedPlayerIds: tournamentState.pausedPlayerIds,
        modeLabel: getModeLabel(tournamentState.mode),
        nextMatchPreview
    });
});
app.post('/tournament/score', (req, res) => {
    const { score1, score2, action } = req.body;
    const pausedIds = req.body.pausedIds || [];
    const currentMatch = tournamentState.matches[tournamentState.currentMatchIndex];
    if (currentMatch && currentMatch.teams && currentMatch.teams.length >= 2) {
        const team1 = currentMatch.teams[0];
        const team2 = currentMatch.teams[1];
        if (team1)
            team1.score = parseInt(score1 || '0', 10);
        if (team2)
            team2.score = parseInt(score2 || '0', 10);
    }
    if (Array.isArray(pausedIds)) {
        tournamentState.pausedPlayerIds = pausedIds;
    }
    else if (pausedIds) {
        tournamentState.pausedPlayerIds = [pausedIds];
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
        await database_1.Database.saveTournament(tournamentState.mode, tournamentState.matches, res.locals.user?.id || null, res.locals.guestSessionId);
    }
    tournamentState.matches = [];
    tournamentState.currentMatchIndex = 0;
    res.redirect('/history');
});
//# sourceMappingURL=app.js.map