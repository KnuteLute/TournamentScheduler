import {
  computeOverallStandings,
  computeTournamentStandings,
  correctMatchScore,
  DomainMatch,
  Participant,
  recalculateTournamentStandings,
} from './index';

const participants: Participant[] = [
  { id: 'a', name: 'Ada' },
  { id: 'b', name: 'Bryn' },
  { id: 'c', name: 'Casey' },
  { id: 'd', name: 'Dee' },
  { id: 'e', name: 'Eli' },
];

function result(
  id: string,
  first: Participant[],
  second: Participant[],
  firstScore: number,
  secondScore: number,
  status: DomainMatch['status'] = 'completed',
): DomainMatch {
  return {
    id,
    round: 1,
    sequence: Number(id.replace(/\D/gu, '')) || 1,
    status,
    sides: [
      { id: `${id}-1`, players: first, score: status === 'completed' ? firstScore : null },
      { id: `${id}-2`, players: second, score: status === 'completed' ? secondScore : null },
    ],
    ...(status === 'completed' ? { endTime: '2026-01-01T00:01:00.000Z' } : {}),
    pauseIntervals: [],
    version: 1,
  };
}

const player = (id: string) => participants.find((candidate) => candidate.id === id)!;

describe('independent standings projections', () => {
  it('counts completed results only and includes zero-appearance tournament players', () => {
    const matches = [
      result('m1', [player('a')], [player('b')], 10, 4),
      result('m2', [player('c')], [player('d')], 0, 0),
      result('m3', [player('a')], [player('c')], 9, 8, 'in_progress'),
      result('m4', [player('b')], [player('d')], 0, 0, 'paused'),
      result('m5', [player('d')], [player('e')], 0, 0, 'skipped'),
    ];
    const standings = computeTournamentStandings('1v1', participants, matches);
    const ada = standings.players.find((row) => row.playerIds[0] === 'a')!;
    const eli = standings.players.find((row) => row.playerIds[0] === 'e')!;
    expect(ada).toMatchObject({ matchesPlayed: 1, wins: 1, pointsFor: 10, pointsAgainst: 4, pointDifferential: 6 });
    expect(eli).toMatchObject({ matchesPlayed: 0, wins: 0, draws: 0, losses: 0, pointsFor: 0 });
    expect(standings.players.find((row) => row.playerIds[0] === 'c'))
      .toMatchObject({ matchesPlayed: 1, draws: 1, pointsFor: 0 });
    expect(standings.teams.find((row) => row.playerIds[0] === 'a')?.wins).toBe(1);
  });

  it('keeps rotating partnership rows independent from player aggregate rows', () => {
    const match = result('m1', [player('a'), player('b')], [player('c'), player('d')], 15, 11);
    const standings = computeTournamentStandings('2v2_rotating', participants, [match]);
    expect(standings.players.find((row) => row.playerIds[0] === 'a'))
      .toMatchObject({ matchesPlayed: 1, wins: 1, pointsFor: 15 });
    expect(standings.teams).toHaveLength(2);
    expect(standings.teams.find((row) => row.playerIds.join('|') === 'a|b'))
      .toMatchObject({ subjectType: 'rotating_pair', matchesPlayed: 1, wins: 1, pointsFor: 15 });
    expect(standings.players.find((row) => row.playerIds[0] === 'e')?.matchesPlayed).toBe(0);
  });

  it('includes zero-appearance configured fixed teams in the team projection', () => {
    const sixPlayers = [...participants, { id: 'f', name: 'Fran' }];
    const teams = [
      { id: 't1', name: 'One', playerIds: ['a', 'b'] as [string, string] },
      { id: 't2', name: 'Two', playerIds: ['c', 'd'] as [string, string] },
      { id: 't3', name: 'Three', playerIds: ['e', 'f'] as [string, string] },
    ];
    const match = result('m1', [player('a'), player('b')], [player('c'), player('d')], 3, 1);
    match.sides[0].fixedTeamId = 't1';
    match.sides[1].fixedTeamId = 't2';
    const standings = computeTournamentStandings('2v2_fixed', sixPlayers, [match], teams);
    expect(standings.teams.find((row) => row.teamId === 't3'))
      .toMatchObject({ matchesPlayed: 0, wins: 0, pointsFor: 0 });
  });

  it('ranks by wins, differential, then points-for and shares competitive ranks', () => {
    const match1 = result('m1', [player('a'), player('b')], [player('c'), player('d')], 10, 5);
    const match2 = result('m2', [player('c'), player('d')], [player('e'), player('a')], 8, 3);
    const matches = [match1, match2];
    const standings = computeTournamentStandings('2v2_rotating', participants, matches);
    const cRow = standings.players.find((row) => row.playerIds[0] === 'c')!;
    const dRow = standings.players.find((row) => row.playerIds[0] === 'd')!;
    expect(cRow.rank).toBe(dRow.rank);

    const pointsForRows = computeTournamentStandings('1v1', participants, [
      result('m1', [player('a')], [player('b')], 10, 5),
      result('m2', [player('c')], [player('d')], 20, 15),
    ]).players;
    expect(pointsForRows.find((row) => row.playerIds[0] === 'c')!.rank)
      .toBeLessThan(pointsForRows.find((row) => row.playerIds[0] === 'a')!.rank);

    const tieRows = computeTournamentStandings('2v2_rotating', participants, [
      result('m1', [player('a'), player('b')], [player('c'), player('d')], 4, 1),
      result('m2', [player('c'), player('d')], [player('a'), player('b')], 4, 1),
    ]).teams;
    const sameRecord = tieRows.filter((row) => row.wins === 1 && row.pointDifferential === 0 && row.pointsFor === 5);
    expect(sameRecord).toHaveLength(2);
    expect(sameRecord[0]!.rank).toBe(sameRecord[1]!.rank);
  });

  it('recomputes corrected results instead of double-counting the former result', () => {
    const original = result('m1', [player('a')], [player('b')], 7, 3);
    const corrected = correctMatchScore(original, [2, 8], 'active', '2026-01-01T00:02:00.000Z');
    const standings = recalculateTournamentStandings('1v1', participants, [corrected]);
    expect(standings.players.find((row) => row.playerIds[0] === 'a'))
      .toMatchObject({ matchesPlayed: 1, wins: 0, losses: 1, pointsFor: 2, pointsAgainst: 8 });
    expect(standings.players.find((row) => row.playerIds[0] === 'b'))
      .toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0, pointsFor: 8, pointsAgainst: 2 });
  });

  it('aggregates only the explicitly supplied tournament history for overall standings', () => {
    const first = result('m1', [player('a')], [player('b')], 6, 2);
    const second = result('m2', [player('a')], [player('c')], 1, 5);
    const overall = computeOverallStandings({
      tournaments: [
        { mode: '1v1', participants: [player('a'), player('b')], matches: [first] },
        { mode: '1v1', participants: [player('a'), player('c')], matches: [second] },
      ],
    });
    expect(overall.players.find((row) => row.playerIds[0] === 'a'))
      .toMatchObject({ matchesPlayed: 2, wins: 1, losses: 1, pointsFor: 7, pointsAgainst: 7 });
    expect(overall.teams.find((row) => row.playerIds[0] === 'b')?.matchesPlayed).toBe(1);
  });
});
