import {
  completeMatch,
  computeTournamentStandings,
  finishTournament,
  generate1v1RoundRobin,
  pauseMatch,
  pauseTournament,
  resumeMatch,
  resumeTournament,
  skipMatch,
  startMatch,
  startTournament,
  TournamentState,
  updatePlayerAvailability,
} from './index';

const participants = [
  { id: 'a', name: 'Ada' },
  { id: 'b', name: 'Bryn' },
  { id: 'c', name: 'Casey' },
];
const startTime = '2026-03-01T10:00:00.000Z';
const later = '2026-03-01T10:05:00.000Z';

function draftTournament(): TournamentState {
  return {
    id: 'tournament-1',
    mode: '1v1',
    status: 'draft',
    participants,
    seed: 'lifecycle-seed',
    generatorVersion: '1',
    pausedPlayerIds: [],
    matches: [],
    version: 1,
  };
}

describe('tournament and match lifecycle', () => {
  it('starts with deterministic schedule and enforces tournament transitions', () => {
    const started = startTournament(draftTournament(), startTime);
    expect(started.tournament.status).toBe('active');
    expect(started.tournament.matches).toHaveLength(3);
    expect(started.tournament.version).toBe(2);
    expect(() => startTournament(started.tournament, later)).toThrow(/Cannot start/);

    const paused = pauseTournament(started.tournament, later);
    expect(paused.status).toBe('paused');
    expect(resumeTournament(paused, '2026-03-01T10:06:00.000Z').status).toBe('active');
    expect(finishTournament(paused, '2026-03-01T10:07:00.000Z').status).toBe('completed');
  });

  it('requires previous matches resolved and blocks paused participants or overlapping matches', () => {
    const matches = generate1v1RoundRobin(participants, 'match-seed').rounds.flatMap((round) => round.matches);
    const first = matches[0]!;
    const laterMatch = matches[1]!;
    expect(() => startMatch(laterMatch, 'active', [], matches, startTime)).toThrow(/Earlier scheduled/);
    expect(() => startMatch(first, 'active', [first.sides[0].players[0]!.id], matches, startTime)).toThrow(/paused participant/);
    const inProgress = startMatch(first, 'active', [], matches, startTime);
    expect(() => startMatch(laterMatch, 'active', [], [...matches, inProgress], startTime)).toThrow(/Only one match/);
  });

  it('pauses current play when a participant is newly paused and requires explicit match resume', () => {
    const matches = generate1v1RoundRobin(participants, 'pause-seed').rounds.flatMap((round) => round.matches);
    const inProgress = startMatch(matches[0]!, 'active', [], matches, startTime);
    expect(pauseMatch(inProgress, 'active', later).status).toBe('paused');
    const playerId = inProgress.sides[0].players[0]!.id;
    const update = updatePlayerAvailability(draftTournamentWith(inProgress), [playerId], inProgress, later);
    expect(update.pausedPlayerIds).toEqual([playerId]);
    expect(update.match?.status).toBe('paused');
    expect(() => resumeMatch(update.match!, 'active', [playerId], '2026-03-01T10:06:00.000Z')).toThrow(/participants is paused/);
    const resumed = resumeMatch(update.match!, 'active', [], '2026-03-01T10:06:00.000Z');
    expect(resumed.status).toBe('in_progress');
    expect(resumed.pauseIntervals[0]).toMatchObject({ pausedAt: later, resumedAt: '2026-03-01T10:06:00.000Z' });
  });

  it('records bounded integer scores and skips without standings credit', () => {
    const matches = generate1v1RoundRobin(participants, 'score-seed').rounds.flatMap((round) => round.matches);
    const inProgress = startMatch(matches[0]!, 'active', [], matches, startTime);
    expect(() => completeMatch(inProgress, [-1, 1], 'active', later)).toThrow(/integer from 0/);
    expect(() => completeMatch(inProgress, [1.5, 1], 'active', later)).toThrow(/integer from 0/);
    expect(() => completeMatch(inProgress, [1_000_001, 1], 'active', later)).toThrow(/integer from 0/);
    expect(() => completeMatch(inProgress, [Number.POSITIVE_INFINITY, 1], 'active', later)).toThrow(/integer from 0/);
    expect(() => completeMatch(inProgress, [0, 0], 'active', later, [inProgress.sides[0].players[0]!.id]))
      .toThrow(/paused participant/);

    const completed = completeMatch(inProgress, [0, 0], 'active', later);
    expect(completed.status).toBe('completed');
    expect(computeTournamentStandings('1v1', participants, [completed]).players
      .filter((row) => row.matchesPlayed === 1).every((row) => row.draws === 1)).toBe(true);
    const skipped = skipMatch(matches[1]!, 'active', later);
    expect(skipped.status).toBe('skipped');
    expect(skipped.sides.every((side) => side.score === null)).toBe(true);
    expect(computeTournamentStandings('1v1', participants, [skipped]).players.every((row) => row.matchesPlayed === 0)).toBe(true);
  });

  it('preserves pending matches when a tournament is finished early', () => {
    const started = startTournament(draftTournament(), startTime).tournament;
    const finished = finishTournament(started, later);
    expect(finished.matches.every((match) => match.status === 'scheduled')).toBe(true);
    expect(computeTournamentStandings('1v1', participants, finished.matches).players.every((row) => row.matchesPlayed === 0)).toBe(true);
  });
});

function draftTournamentWith(match: TournamentState['matches'][number]): TournamentState {
  return { ...draftTournament(), status: 'active', matches: [match] };
}
