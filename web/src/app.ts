import express from 'express';
import path from 'path';
import fs from 'fs';
import expressLayouts from 'express-ejs-layouts';
import cookieParser from 'cookie-parser';
import { Database } from './lib/database';
import { AuthUtils } from './lib/auth';
import { randomUUID } from 'crypto';
import { generate1v1Matches, generateFixed2v2Matches , generateNextDynamic2v2Match } from './lib/scheduler';
import { Match, Participant } from './types';

const app = express();
const DEFAULT_PORT = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// --- Authentication Middleware ---
app.use(async (req, res, next) => {
    res.locals.user = null; // Default to no user for templates
    res.locals.guestSessionId = null;

    // Handle Auth Cookie
    const token = req.cookies.token;
    if (token) {
        const decoded = AuthUtils.verifyToken(token);
        if (decoded && decoded.userId) {
            const user = await Database.getUserById(decoded.userId);
            if (user) {
                res.locals.user = { id: user.id, username: user.username };
            }
        }
    }

    // Handle Guest Session Cookie if not authenticated
    if (!res.locals.user) {
        let guestSession = req.cookies.guest_session;
        if (!guestSession) {
            guestSession = randomUUID();
            res.cookie('guest_session', guestSession, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }); // 1 day
        }
        res.locals.guestSessionId = guestSession;
    }

    next();
});



// --- Auth Routes ---
app.get('/login', (req, res) => {
    res.render('login', { title: 'Log In', hideHeader: true, error: null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await Database.getUserByUsername(username);
    if (!user) {
        return res.render('login', { title: 'Log In', hideHeader: true, error: 'Invalid username or password.' });
    }
    const isMatch = await AuthUtils.comparePassword(password, user.password_hash);
    if (!isMatch) {
         return res.render('login', { title: 'Log In', hideHeader: true, error: 'Invalid username or password.' });
    }
    const token = AuthUtils.generateToken(user.id);
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 });
    
    // Merge guest data
    const guestSession = req.cookies.guest_session;
    if (guestSession) {
        await Database.mergeGuestData(user.id, guestSession);
        res.clearCookie('guest_session');
    }
    
    res.redirect('/');
});

app.get('/signup', (req, res) => {
    res.render('signup', { title: 'Sign Up', hideHeader: true, error: null });
});

app.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    if (password.length < 6) {
        return res.render('signup', { title: 'Sign Up', hideHeader: true, error: 'Password must be at least 6 characters.' });
    }
    const hash = await AuthUtils.hashPassword(password);
    const userId = await Database.createUser(username, hash);
    if (!userId) {
        return res.render('signup', { title: 'Sign Up', hideHeader: true, error: 'Username already taken.' });
    }
    const token = AuthUtils.generateToken(userId);
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 });
    
    // Merge guest data
    const guestSession = req.cookies.guest_session;
    if (guestSession) {
        await Database.mergeGuestData(userId, guestSession);
        res.clearCookie('guest_session');
    }
    
    res.redirect('/');
});

app.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.redirect('/');
});

app.get('/', async (req, res) => {
    const players = await Database.getPlayers();
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
    const players = await Database.getPlayers();
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
            await Database.addPlayer(name.trim());
        } catch (e) {
            console.error(e);
        }
    }
    res.redirect(`/play/${mode}`);
});

app.get('/history', async (req, res) => {
    const tournaments = await Database.getTournamentHistory();
    res.render('history', { 
        title: 'Turneringshistorikk',
        tournaments: tournaments.reverse() // show newest first
    });
});

app.get('/history/:id', async (req, res) => {
    const tournaments = await Database.getTournamentHistory();
    const tournament = tournaments.find(t => t.id === req.params.id);
    if (!tournament) return res.redirect('/history');
    
    res.render('history_detail', {
        title: `Turnering Detaljer`,
        tournament: tournament
    });
});

app.get('/leaderboard', async (req, res) => {
    const allPlayers = await Database.getPlayers();
    const playerDir = path.join(__dirname, '../database/players');
    
    let leaderboard = [];
    for (const p of allPlayers) {
        try {
            const statFile = path.join(playerDir, `${p.id}.json`);
            if (fs.existsSync(statFile)) {
                const stats = JSON.parse(fs.readFileSync(statFile, 'utf8'));
                leaderboard.push(stats);
            }
        } catch (e) {}
    }
    
    leaderboard.sort((a, b) => b.wins - a.wins || b.diff - a.diff);

    res.render('leaderboard', { 
        title: 'Ledertavle (Overall)',
        leaderboard: leaderboard
    });
});

if (process.env.NODE_ENV !== 'production') {
    const server = app.listen(DEFAULT_PORT, () => {
        console.log(`Server is running on http://localhost:${DEFAULT_PORT}`);
    }).on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${DEFAULT_PORT} is busy, trying ${DEFAULT_PORT + 1}...`);
            app.listen(DEFAULT_PORT + 1);
        } else {
            console.error(err);
        }
    });
}

// Export the app for Vercel Serverless environment
export default app;

let tournamentState = {
    mode: '',
    matches: [] as Match[],
    participants: [] as Participant[],
    pausedPlayerIds: [] as string[],
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
    
    const allPlayers = await Database.getPlayers();
    const participants: Participant[] = playerIds.map((id: string) => {
        const found = allPlayers.find(p => p.id === id);
        return found ? found : { id, name: id };
    });
    
    tournamentState.mode = mode;
    tournamentState.currentMatchIndex = 0;
    tournamentState.participants = participants;
    tournamentState.pausedPlayerIds = [];

    if (mode === '1v1') {
        tournamentState.matches = generate1v1Matches(participants);
    } else if (mode === '2v2-rotating') {
        if (participants.length < 3) {
            return res.redirect(`/play/${mode}?error=Need at least 3 players for Rotating 2v2`);
        }
        tournamentState.matches = [];
        const initialMatch = generateNextDynamic2v2Match([], participants, []);
        if (initialMatch) tournamentState.matches.push(initialMatch);
    } else if (mode === '2v2-fixed') {
        if (participants.length < 4) {
            return res.redirect(`/play/${mode}?error=Need at least 4 players for Fixed 2v2 (creates 2 teams)`);
        }
        tournamentState.matches = generateFixed2v2Matches(participants);
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
        if (team1) team1.score = parseInt(score1 || '0', 10);
        if (team2) team2.score = parseInt(score2 || '0', 10);
    }
    
    if (action === 'prev') {
        res.redirect('/tournament/prev');
    } else if (action === 'next') {
        res.redirect('/tournament/next');
    } else if (action === 'skip') {
        tournamentState.matches.splice(tournamentState.currentMatchIndex, 1);
        if (tournamentState.mode === '2v2-rotating') {
            const nextMatch = generateNextDynamic2v2Match(tournamentState.matches, tournamentState.participants, tournamentState.pausedPlayerIds);
            if (nextMatch) tournamentState.matches.push(nextMatch);
            else if (tournamentState.matches.length === 0) return res.redirect('/tournament/finish');
        }
        if (tournamentState.currentMatchIndex >= tournamentState.matches.length) {
            tournamentState.currentMatchIndex = Math.max(0, tournamentState.matches.length - 1);
        }
        res.redirect('/tournament/active');
    } else if (action === 'finish') {
        res.redirect(307, '/tournament/finish');
    } else {
        res.redirect('/tournament/active');
    }
});

app.get('/tournament/next', (req, res) => {
    if (tournamentState.currentMatchIndex < tournamentState.matches.length - 1) {
        tournamentState.currentMatchIndex++;
    } else if (tournamentState.mode === '2v2-rotating') {
        const nextMatch = generateNextDynamic2v2Match(tournamentState.matches, tournamentState.participants, tournamentState.pausedPlayerIds);
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
        await Database.saveTournament(tournamentState.mode, tournamentState.matches);
    }
    tournamentState.matches = [];
    tournamentState.currentMatchIndex = 0;
    res.redirect('/history');
});
