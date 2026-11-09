import { assertValidMatch, assertValidTournamentInput, normalizeDisplayName } from './validation';
import { compareText } from './random';
import {
  DomainMatch,
  FixedTeam,
  OverallStandings,
  OverallStandingsInput,
  Participant,
  StandingRow,
  StandingStats,
  StandingSubjectType,
  TournamentMode,
  TournamentStandings,
} from './types';

function emptyStats(): StandingStats {
  return {
    matchesPlayed: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    pointDifferential: 0,
  };
}

function canonicalIds(ids: readonly string[]): string[] {
  return ids.slice().sort(compareText);
}

function playerName(participants: readonly Participant[], id: string): string {
  return participants.find((participant) => participant.id === id)?.name ?? id;
}

function sideOutcome(own: number, opposing: number): 'win' | 'draw' | 'loss' {
  if (own > opposing) return 'win';
  if (own < opposing) return 'loss';
  return 'draw';
}

function applyResult(row: StandingRow, ownScore: number, opposingScore: number): void {
  row.matchesPlayed += 1;
  row.pointsFor += ownScore;
  row.pointsAgainst += opposingScore;
  row.pointDifferential = row.pointsFor - row.pointsAgainst;
  const outcome = sideOutcome(ownScore, opposingScore);
  row[outcome === 'win' ? 'wins' : outcome === 'draw' ? 'draws' : 'losses'] += 1;
}

function makeRow(
  key: string,
  subjectType: StandingSubjectType,
  name: string,
  playerIds: readonly string[],
  teamId?: string,
): StandingRow {
  const row: StandingRow = {
    rank: 0,
    key,
    subjectType,
    name,
    playerIds: canonicalIds(playerIds),
    ...emptyStats(),
  };
  if (teamId !== undefined) row.teamId = teamId;
  return row;
}

function rankRows(rows: StandingRow[]): StandingRow[] {
  const ordered = rows.slice().sort((left, right) =>
    right.wins - left.wins
      || right.pointDifferential - left.pointDifferential
      || right.pointsFor - left.pointsFor
    || compareText(normalizeDisplayName(left.name), normalizeDisplayName(right.name))
      || compareText(left.key, right.key));
  let previous: StandingRow | undefined;
  let previousRank = 0;
  ordered.forEach((row, index) => {
    if (!previous || row.wins !== previous.wins
      || row.pointDifferential !== previous.pointDifferential
      || row.pointsFor !== previous.pointsFor) {
      previousRank = index + 1;
    }
    row.rank = previousRank;
    previous = row;
  });
  return ordered;
}

function teamDescriptors(
  mode: TournamentMode,
  sidePlayers: readonly Participant[],
  fixedTeamById: Map<string, FixedTeam>,
  side: DomainMatch['sides'][number],
): { key: string; type: StandingSubjectType; name: string; playerIds: string[]; teamId?: string } {
  const playerIds = canonicalIds(sidePlayers.map((player) => player.id));
  if (mode === '1v1') {
    const player = sidePlayers[0]!;
    return { key: `single:${player.id}`, type: 'single_player_side', name: player.name, playerIds };
  }
  if (mode === '2v2_fixed') {
    const fixedTeam = side.fixedTeamId ? fixedTeamById.get(side.fixedTeamId) : undefined;
    if (fixedTeam) {
      return {
        key: `fixed:${fixedTeam.id}`,
        type: 'fixed_team',
        name: fixedTeam.name,
        playerIds,
        teamId: fixedTeam.id,
      };
    }
    const stableKey = playerIds.join('\u0000');
    return {
      key: `fixed-pair:${stableKey}`,
      type: 'fixed_team',
      name: playerIds.map((id) => playerName(sidePlayers, id)).join(' + '),
      playerIds,
    };
  }
  const stableKey = playerIds.join('\u0000');
  return {
    key: `rotating:${stableKey}`,
    type: 'rotating_pair',
    name: playerIds.map((id) => playerName(sidePlayers, id)).join(' + '),
    playerIds,
  };
}

function mergeStats(target: StandingRow, source: StandingStats): void {
  target.matchesPlayed += source.matchesPlayed;
  target.wins += source.wins;
  target.draws += source.draws;
  target.losses += source.losses;
  target.pointsFor += source.pointsFor;
  target.pointsAgainst += source.pointsAgainst;
  target.pointDifferential = target.pointsFor - target.pointsAgainst;
}

export function computeTournamentStandings(
  mode: TournamentMode,
  participants: readonly Participant[],
  matches: readonly DomainMatch[],
  fixedTeams: readonly FixedTeam[] = [],
): TournamentStandings {
  assertValidTournamentInput(mode, participants, mode === '2v2_fixed' ? { fixedTeams } : {});
  const playerRows = new Map<string, StandingRow>();
  participants.forEach((participant) => {
    playerRows.set(participant.id, makeRow(`player:${participant.id}`, 'player', participant.name, [participant.id]));
  });

  const fixedTeamById = new Map(fixedTeams.map((team) => [team.id, team]));
  const teamRows = new Map<string, StandingRow>();
  if (mode === '1v1') {
    participants.forEach((participant) => {
      const row = makeRow(`single:${participant.id}`, 'single_player_side', participant.name, [participant.id]);
      teamRows.set(row.key, row);
    });
  }
  if (mode === '2v2_fixed') {
    fixedTeams.forEach((team) => {
      const row = makeRow(`fixed:${team.id}`, 'fixed_team', team.name, team.playerIds, team.id);
      teamRows.set(row.key, row);
    });
  }

  matches.forEach((match) => {
    if (match.status !== 'completed') return;
    assertValidMatch(match, mode, participants, fixedTeams);
    const firstScore = match.sides[0].score!;
    const secondScore = match.sides[1].score!;
    match.sides.forEach((side, sideIndex) => {
      const ownScore = sideIndex === 0 ? firstScore : secondScore;
      const opposingScore = sideIndex === 0 ? secondScore : firstScore;
      side.players.forEach((player) => {
        const row = playerRows.get(player.id);
        if (!row) throw new Error(`Completed match participant ${player.id} is missing from the roster.`);
        applyResult(row, ownScore, opposingScore);
      });
      const descriptor = teamDescriptors(mode, side.players, fixedTeamById, side);
      let teamRow = teamRows.get(descriptor.key);
      if (!teamRow) {
        teamRow = makeRow(descriptor.key, descriptor.type, descriptor.name, descriptor.playerIds, descriptor.teamId);
        teamRows.set(descriptor.key, teamRow);
      }
      applyResult(teamRow, ownScore, opposingScore);
    });
  });

  return { players: rankRows(Array.from(playerRows.values())), teams: rankRows(Array.from(teamRows.values())) };
}

export function computeOverallStandings(input: OverallStandingsInput): OverallStandings {
  const allPlayers = new Map<string, Participant>();
  input.players?.forEach((player) => allPlayers.set(player.id, { ...player }));
  input.tournaments.forEach((tournament) => {
    tournament.participants.forEach((player) => {
      if (!allPlayers.has(player.id)) allPlayers.set(player.id, { ...player });
    });
  });
  const playerRows = new Map<string, StandingRow>();
  allPlayers.forEach((player) => {
    playerRows.set(player.id, makeRow(`player:${player.id}`, 'player', player.name, [player.id]));
  });
  const teamRows = new Map<string, StandingRow>();

  input.tournaments.forEach((tournament) => {
    const standings = computeTournamentStandings(
      tournament.mode,
      tournament.participants,
      tournament.matches,
      tournament.fixedTeams,
    );
    standings.players.forEach((source) => {
      const target = playerRows.get(source.playerIds[0]!);
      if (target) mergeStats(target, source);
    });
    standings.teams.forEach((source) => {
      let key = source.key;
      if (source.subjectType === 'single_player_side') key = `single:${source.playerIds[0]}`;
      let target = teamRows.get(key);
      if (!target) {
        target = makeRow(key, source.subjectType, source.name, source.playerIds, source.teamId);
        teamRows.set(key, target);
      }
      mergeStats(target, source);
    });
  });

  return { players: rankRows(Array.from(playerRows.values())), teams: rankRows(Array.from(teamRows.values())) };
}

export function recalculateTournamentStandings(
  mode: TournamentMode,
  participants: readonly Participant[],
  matches: readonly DomainMatch[],
  fixedTeams: readonly FixedTeam[] = [],
): TournamentStandings {
  return computeTournamentStandings(mode, participants, matches, fixedTeams);
}
