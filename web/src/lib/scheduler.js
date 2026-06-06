"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateNextDynamic2v2Match = exports.generateFixed2v2Matches = exports.generateRotating2v2Matches = exports.generate1v1Matches = void 0;
function getName(id, participants) {
    return participants.find(p => p.id === id)?.name || id;
}
/**
 * Ported from round_robin_1v1_scheduler.cpp
 * Generates 1v1 matchups using a rotational pattern (circle method)
 */
function generate1v1Matches(participants) {
    const matches = [];
    const playerIds = participants.map(p => p.id);
    let rotating = [...playerIds];
    if (rotating.length % 2 !== 0) {
        rotating.push("BYE");
    }
    const count = rotating.length;
    for (let round = 0; round < count - 1; round++) {
        for (let i = 0; i < count / 2; i++) {
            const p1 = rotating[i];
            const p2 = rotating[count - 1 - i];
            if (p1 !== "BYE" && p2 !== "BYE") {
                matches.push({
                    id: `1v1-${round}-${i}`,
                    teams: [
                        { id: `t-${p1}`, participants: [{ id: p1, name: getName(p1, participants) }], score: 0 },
                        { id: `t-${p2}`, participants: [{ id: p2, name: getName(p2, participants) }], score: 0 }
                    ]
                });
            }
        }
        // Rotate all except first
        const last = rotating.pop();
        rotating.splice(1, 0, last);
    }
    return matches;
}
exports.generate1v1Matches = generate1v1Matches;
/**
 * Ported from round_robin_2v2_rotating.cpp
 * Generates 2v2 matches with rotating teams
 */
function generateRotating2v2Matches(participants) {
    const outputMatches = [];
    const playerIds = participants.map(p => p.id);
    const playersWithBye = [...playerIds];
    const hasBye = playersWithBye.length % 2 !== 0;
    if (hasBye) {
        playersWithBye.push("BYE");
    }
    const n = playersWithBye.length;
    if (n < 4)
        return outputMatches;
    // Step 1: Generate all possible unique 2-player teams
    const teams = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            teams.push({ p1: playersWithBye[i], p2: playersWithBye[j] });
        }
    }
    // Shuffle
    for (let i = teams.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [teams[i], teams[j]] = [teams[j], teams[i]];
    }
    const playerMatches = {};
    playersWithBye.forEach(id => {
        if (id !== "BYE")
            playerMatches[id] = 0;
    });
    const used = new Array(teams.length).fill(false);
    let madeMatch;
    do {
        madeMatch = false;
        let bestTeamA = -1;
        let minUsageA = Infinity;
        // Find Team A (least used players)
        for (let a = 0; a < teams.length; a++) {
            if (used[a])
                continue;
            const ta = teams[a];
            // Skip BYE teams initially if possible
            if (hasBye && (ta.p1 === "BYE" || ta.p2 === "BYE") && minUsageA !== Infinity)
                continue;
            let usage = 0;
            if (ta.p1 !== "BYE")
                usage += playerMatches[ta.p1];
            if (ta.p2 !== "BYE")
                usage += playerMatches[ta.p2];
            if (usage < minUsageA) {
                minUsageA = usage;
                bestTeamA = a;
            }
        }
        if (bestTeamA === -1)
            break;
        // Find compatible Team B
        let bestTeamB = -1;
        let minUsageB = Infinity;
        const ta = teams[bestTeamA];
        for (let b = 0; b < teams.length; b++) {
            if (used[b] || b === bestTeamA)
                continue;
            const tb = teams[b];
            // Ensure disjoint sets
            if (ta.p1 !== tb.p1 && ta.p1 !== tb.p2 && ta.p2 !== tb.p1 && ta.p2 !== tb.p2) {
                let usage = 0;
                if (tb.p1 !== "BYE")
                    usage += playerMatches[tb.p1];
                if (tb.p2 !== "BYE")
                    usage += playerMatches[tb.p2];
                if (usage < minUsageB) {
                    minUsageB = usage;
                    bestTeamB = b;
                }
            }
        }
        if (bestTeamB !== -1) {
            const teamA = teams[bestTeamA];
            const teamB = teams[bestTeamB];
            used[bestTeamA] = used[bestTeamB] = true;
            madeMatch = true;
            // Update usage even if it has BYE
            if (teamA.p1 !== "BYE")
                playerMatches[teamA.p1]++;
            if (teamA.p2 !== "BYE")
                playerMatches[teamA.p2]++;
            if (teamB.p1 !== "BYE")
                playerMatches[teamB.p1]++;
            if (teamB.p2 !== "BYE")
                playerMatches[teamB.p2]++;
            // Only push if no BYE is involved in the match
            if (!(teamA.p1 === "BYE" || teamA.p2 === "BYE" || teamB.p1 === "BYE" || teamB.p2 === "BYE")) {
                outputMatches.push({
                    id: `2v2r-${outputMatches.length}`,
                    teams: [
                        {
                            id: `t-${teamA.p1}-${teamA.p2}`,
                            participants: [{ id: teamA.p1, name: getName(teamA.p1, participants) }, { id: teamA.p2, name: getName(teamA.p2, participants) }],
                            score: 0
                        },
                        {
                            id: `t-${teamB.p1}-${teamB.p2}`,
                            participants: [{ id: teamB.p1, name: getName(teamB.p1, participants) }, { id: teamB.p2, name: getName(teamB.p2, participants) }],
                            score: 0
                        }
                    ]
                });
            }
        }
    } while (madeMatch);
    return outputMatches;
}
exports.generateRotating2v2Matches = generateRotating2v2Matches;
/**
 * Ported from round_robin_2v2_same_team.cpp
 * Generates 2v2 matches with fixed teams (pairs of players)
 */
function generateFixed2v2Matches(participants) {
    const matches = [];
    const playerIds = participants.map(p => p.id);
    // Create fixed teams (pairs)
    const teams = [];
    for (let i = 0; i + 1 < playerIds.length; i += 2) {
        teams.push([playerIds[i], playerIds[i + 1]]);
    }
    if (teams.length < 2)
        return matches;
    let rotatingTeams = [...teams];
    if (rotatingTeams.length % 2 !== 0) {
        rotatingTeams.push(["BYE", "BYE"]);
    }
    const count = rotatingTeams.length;
    for (let round = 0; round < count - 1; round++) {
        for (let i = 0; i < count / 2; i++) {
            const t1 = rotatingTeams[i];
            const t2 = rotatingTeams[count - 1 - i];
            if (t1[0] !== "BYE" && t2[0] !== "BYE") {
                matches.push({
                    id: `2v2f-${round}-${i}`,
                    teams: [
                        {
                            id: `t-${t1[0]}-${t1[1]}`,
                            participants: [
                                { id: t1[0] || "", name: getName(t1[0] || "", participants) },
                                { id: t1[1] || "", name: getName(t1[1] || "", participants) }
                            ],
                            score: 0
                        },
                        {
                            id: `t-${t2[0]}-${t2[1]}`,
                            participants: [
                                { id: t2[0] || "", name: getName(t2[0] || "", participants) },
                                { id: t2[1] || "", name: getName(t2[1] || "", participants) }
                            ],
                            score: 0
                        }
                    ]
                });
            }
        }
        const last = rotatingTeams.pop();
        rotatingTeams.splice(1, 0, last);
    }
    return matches;
}
exports.generateFixed2v2Matches = generateFixed2v2Matches;
function generateNextDynamic2v2Match(pastMatches, participants, pausedIds) {
    const statsRaw = {};
    for (const p of participants) {
        statsRaw[p.id] = {
            id: p.id,
            amount_times_played: 0,
            amount_times_played_in_a_row: 0,
            time_since_last_played: 0,
            played_with: new Set()
        };
    }
    for (const match of pastMatches) {
        const playersInMatch = new Set();
        match.teams.forEach(t => t.participants.forEach(p => playersInMatch.add(p.id)));
        if (match.teams.length === 2) {
            const team1 = match.teams[0]?.participants.map(p => p.id) || [];
            const team2 = match.teams[1]?.participants.map(p => p.id) || [];
            const processTeam = (t) => {
                if (t.length === 2) {
                    const p1 = t[0];
                    const p2 = t[1];
                    if (statsRaw[p1] && statsRaw[p2]) {
                        if (statsRaw[p1].played_with.has(p2)) {
                            // Implies a reset happened prior to this match
                            Object.values(statsRaw).forEach(s => s.played_with.clear());
                        }
                        statsRaw[p1].played_with.add(p2);
                        statsRaw[p2].played_with.add(p1);
                    }
                }
            };
            processTeam(team1);
            processTeam(team2);
        }
        for (const p of participants) {
            const pid = p.id;
            if (!statsRaw[pid])
                continue;
            if (playersInMatch.has(pid)) {
                statsRaw[pid].amount_times_played += 1;
                statsRaw[pid].amount_times_played_in_a_row += 1;
                statsRaw[pid].time_since_last_played = 0;
            }
            else {
                statsRaw[pid].amount_times_played_in_a_row = 0;
                statsRaw[pid].time_since_last_played += 1;
            }
        }
    }
    const activeParticipants = participants.filter(p => !pausedIds.includes(p.id));
    if (activeParticipants.length < 4) {
        console.log('less than 4');
        return null;
    }
    const stats = activeParticipants.map(p => statsRaw[p.id]);
    const getNextPlayer = (candidates) => {
        if (candidates.length === 0)
            return null;
        let minPlayed = Math.min(...candidates.map(c => c.amount_times_played));
        let filtered = candidates.filter(c => c.amount_times_played === minPlayed);
        if (filtered.length === 1)
            return filtered[0] || null;
        let maxOutTime = Math.max(...filtered.map(c => c.time_since_last_played));
        filtered = filtered.filter(c => c.time_since_last_played === maxOutTime);
        if (filtered.length === 1)
            return filtered[0] || null;
        let minInRow = Math.min(...filtered.map(c => c.amount_times_played_in_a_row));
        filtered = filtered.filter(c => c.amount_times_played_in_a_row === minInRow);
        return filtered[0] || null;
    };
    const firstPlayer = getNextPlayer(stats);
    if (!firstPlayer)
        return null;
    let candidatesForSecond = stats.filter(c => c.id !== firstPlayer.id && !firstPlayer.played_with.has(c.id));
    let secondPlayer = getNextPlayer(candidatesForSecond);
    if (!secondPlayer) {
        stats.forEach(s => s.played_with.clear());
        candidatesForSecond = stats.filter(c => c.id !== firstPlayer.id);
        secondPlayer = getNextPlayer(candidatesForSecond);
    }
    if (!secondPlayer)
        return null;
    const candidatesForThird = stats.filter(c => c.id !== firstPlayer.id && c.id !== secondPlayer.id);
    const thirdPlayer = getNextPlayer(candidatesForThird);
    if (!thirdPlayer)
        return null;
    let candidatesForFourth = stats.filter(c => c.id !== firstPlayer.id && c.id !== secondPlayer.id && c.id !== thirdPlayer.id && !thirdPlayer.played_with.has(c.id));
    let fourthPlayer = getNextPlayer(candidatesForFourth);
    if (!fourthPlayer) {
        stats.forEach(s => s.played_with.clear());
        candidatesForFourth = stats.filter(c => c.id !== firstPlayer.id && c.id !== secondPlayer.id && c.id !== thirdPlayer.id);
        fourthPlayer = getNextPlayer(candidatesForFourth);
    }
    if (!fourthPlayer)
        return null;
    return {
        id: `2v2d-${pastMatches.length}`,
        teams: [
            {
                id: `t-${firstPlayer.id}-${secondPlayer.id}`,
                participants: [
                    { id: firstPlayer.id, name: getName(firstPlayer.id, participants) },
                    { id: secondPlayer.id, name: getName(secondPlayer.id, participants) }
                ],
                score: 0
            },
            {
                id: `t-${thirdPlayer.id}-${fourthPlayer.id}`,
                participants: [
                    { id: thirdPlayer.id, name: getName(thirdPlayer.id, participants) },
                    { id: fourthPlayer.id, name: getName(fourthPlayer.id, participants) }
                ],
                score: 0
            }
        ]
    };
}
exports.generateNextDynamic2v2Match = generateNextDynamic2v2Match;
//# sourceMappingURL=scheduler.js.map