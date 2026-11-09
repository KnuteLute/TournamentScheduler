import {
  DomainMatch,
  FixedTeam,
  generate1v1RoundRobin,
  generateFixedTeamRoundRobin,
  generateNextRotatingMatch,
  validateTournamentInput,
} from './index';

const roster = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `p${index + 1}`,
  name: `Player ${index + 1}`,
}));

const allMatches = (schedule: ReturnType<typeof generate1v1RoundRobin>): DomainMatch[] =>
  schedule.rounds.flatMap((round) => round.matches);

const pairsIn = (matches: readonly DomainMatch[]) => matches.map((match) =>
  match.sides.flatMap((side) => side.players.map((player) => player.id)).sort().join('|'));

const partnershipKeys = (match: DomainMatch) => match.sides.map((side) =>
  side.players.map((player) => player.id).sort().join('|'));

const completed = (match: DomainMatch): DomainMatch => ({
  ...match,
  status: 'completed',
  sides: [
    { ...match.sides[0], score: 0 },
    { ...match.sides[1], score: 0 },
  ],
  endTime: '2026-01-01T00:01:00.000Z',
});

describe('deterministic round-robin schedules', () => {
  it('creates every 1v1 pair once, with one explicit bye per player for odd rosters', () => {
    const participants = roster(5);
    const schedule = generate1v1RoundRobin(participants, 'seed-a');
    const matches = allMatches(schedule);
    const pairs = pairsIn(matches);

    expect(schedule.rounds).toHaveLength(5);
    expect(matches).toHaveLength(10);
    expect(new Set(pairs).size).toBe(10);
    expect(schedule.rounds.map((round) => round.byeEvents).flat()).toHaveLength(5);
    expect(schedule.rounds.every((round) => round.matches.length === 2)).toBe(true);
    expect(schedule.rounds.every((round) => {
      const playing = round.matches.flatMap((match) => match.sides.flatMap((side) => side.players.map((player) => player.id)));
      return new Set(playing).size === playing.length;
    })).toBe(true);
    expect(new Set(schedule.rounds.map((round) => round.byeEvents[0]?.subjectId)).size).toBe(5);
  });

  it('is byte-for-byte repeatable regardless of equivalent roster input order', () => {
    const participants = roster(7);
    const first = generate1v1RoundRobin(participants, 'persistent-seed');
    const second = generate1v1RoundRobin(participants.slice().reverse(), 'persistent-seed');
    expect(second).toEqual(first);
  });

  it('validates too few players, duplicate IDs, duplicate names, and name normalization', () => {
    expect(validateTournamentInput('1v1', roster(1))).toContainEqual(expect.objectContaining({ code: 'too_few_participants' }));
    expect(validateTournamentInput('1v1', [{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }]))
      .toContainEqual(expect.objectContaining({ code: 'duplicate_participant' }));
    expect(validateTournamentInput('1v1', [{ id: 'a', name: ' Jo  Doe ' }, { id: 'b', name: 'jo doe' }]))
      .toContainEqual(expect.objectContaining({ code: 'duplicate_name' }));
    expect(validateTournamentInput('1v1', [{ id: 'a', name: 'Straße' }, { id: 'b', name: 'STRASSE' }]))
      .toContainEqual(expect.objectContaining({ code: 'duplicate_name' }));
    expect(() => generate1v1RoundRobin(roster(1), 'seed')).toThrow();
  });

  it('creates all fixed-team pairings and represents an odd team count as a bye', () => {
    const participants = roster(6);
    const fixedTeams: FixedTeam[] = [
      { id: 't1', name: 'One', playerIds: ['p1', 'p2'] },
      { id: 't2', name: 'Two', playerIds: ['p3', 'p4'] },
      { id: 't3', name: 'Three', playerIds: ['p5', 'p6'] },
    ];
    const schedule = generateFixedTeamRoundRobin(participants, fixedTeams, 'fixed-seed');
    const matches = schedule.rounds.flatMap((round) => round.matches);
    const teamPairs = matches.map((match) => match.sides.map((side) => side.fixedTeamId).sort().join('|'));
    expect(matches).toHaveLength(3);
    expect(new Set(teamPairs).size).toBe(3);
    expect(schedule.rounds).toHaveLength(3);
    expect(schedule.rounds.map((round) => round.byeEvents).flat()).toHaveLength(3);
    expect(new Set(schedule.rounds.map((round) => round.byeEvents[0]?.subjectId)).size).toBe(3);
    const reorderedTeams = generateFixedTeamRoundRobin(
      participants.slice().reverse(),
      fixedTeams.slice().reverse().map((team) => ({ ...team, playerIds: [team.playerIds[1], team.playerIds[0]] as [string, string] })),
      'fixed-seed',
    );
    expect(reorderedTeams).toEqual(schedule);
  });

  it('rejects fixed rosters with odd counts, repeated or omitted team members', () => {
    const participants = roster(6);
    const invalidTeams: FixedTeam[] = [
      { id: 't1', name: 'One', playerIds: ['p1', 'p2'] },
      { id: 't2', name: 'Two', playerIds: ['p2', 'p3'] },
      { id: 't3', name: 'Three', playerIds: ['p4', 'p5'] },
    ];
    expect(validateTournamentInput('2v2_fixed', participants, { fixedTeams: invalidTeams })
      .map((issue) => issue.code)).toContain('duplicate_team_member');
    expect(validateTournamentInput('2v2_fixed', roster(5), { fixedTeams: invalidTeams })
      .map((issue) => issue.code)).toContain('odd_fixed_roster');
    expect(() => generateFixedTeamRoundRobin(participants, invalidTeams, 'seed')).toThrow();
  });
});

describe('rotating 2v2 next-match generation', () => {
  it('returns no match below four eligible players and excludes paused players', () => {
    expect(generateNextRotatingMatch([], roster(4), ['p1'], 'seed')).toBeNull();
    const result = generateNextRotatingMatch([], roster(5), ['p1'], 'seed');
    expect(result).not.toBeNull();
    const chosen = result!.match.sides.flatMap((side) => side.players.map((player) => player.id));
    expect(chosen).toHaveLength(4);
    expect(new Set(chosen).size).toBe(4);
    expect(chosen).not.toContain('p1');
    expect(result!.restPlayerIds).toHaveLength(0);
    expect(generateNextRotatingMatch([], roster(6), [], 'seed')!.restPlayerIds).toHaveLength(2);
  });

  it('uses deterministic assignments for identical history, pause set, seed and version', () => {
    const participants = roster(8);
    const first = generateNextRotatingMatch([], participants, [], 'rot-seed', 'v1');
    const second = generateNextRotatingMatch([], participants.slice().reverse(), [], 'rot-seed', 'v1');
    expect(second).toEqual(first);
  });

  it('balances cross-match appearances before scheduling repeat appearances', () => {
    const participants = roster(6);
    const first = completed(generateNextRotatingMatch([], participants, [], 'fairness')!.match);
    const second = generateNextRotatingMatch([first], participants, [], 'fairness')!.match;
    const appearances = new Map(participants.map((player) => [player.id, 0]));
    [first, second].forEach((match) => {
      match.sides.flatMap((side) => side.players).forEach((player) => {
        appearances.set(player.id, appearances.get(player.id)! + 1);
      });
    });
    expect(Math.max(...appearances.values()) - Math.min(...appearances.values())).toBeLessThanOrEqual(1);
  });

  it('prefers fresh partnerships until the feasible partnership cycle is exhausted', () => {
    const participants = roster(4);
    const first = completed(generateNextRotatingMatch([], participants, [], 'partners')!.match);
    const second = generateNextRotatingMatch([first], participants, [], 'partners')!.match;
    expect(partnershipKeys(second).some((key) => partnershipKeys(first).includes(key))).toBe(false);
  });

  it('ignores skipped matches in fairness and partnership history', () => {
    const participants = roster(6);
    const skipped = generateNextRotatingMatch([], participants, [], 'skip-seed')!.match;
    skipped.status = 'skipped';
    const withSkippedHistory = generateNextRotatingMatch([skipped], participants, [], 'skip-seed');
    const withoutHistory = generateNextRotatingMatch([], participants, [], 'skip-seed');
    expect(withSkippedHistory!.match.sides.map((side) => side.players.map((player) => player.id).sort()))
      .toEqual(withoutHistory!.match.sides.map((side) => side.players.map((player) => player.id).sort()));
  });

  it('rejects pause IDs outside the tournament roster', () => {
    expect(() => generateNextRotatingMatch([], roster(4), ['foreign'], 'seed')).toThrow(/belong to the roster/);
  });

  it('does not create overlapping live rotating slots', () => {
    const participants = roster(6);
    const pending = generateNextRotatingMatch([], participants, [], 'slot')!.match;
    expect(() => generateNextRotatingMatch([pending], participants, [], 'slot')).toThrow(/Resolve the current/);
  });
});
