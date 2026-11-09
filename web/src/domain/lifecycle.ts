import { generateNextRotatingMatch, generateSchedule } from './schedule';
import { assertValidScore, assertValidTournamentInput, isValidInstant } from './validation';
import {
  DomainMatch,
  FixedTeam,
  MatchPauseInterval,
  MatchStatus,
  NextMatchResult,
  Participant,
  Schedule,
  TournamentMode,
  TournamentStatus,
} from './types';

export interface TournamentState {
  id: string;
  mode: TournamentMode;
  status: TournamentStatus;
  participants: Participant[];
  fixedTeams?: FixedTeam[];
  seed: string;
  generatorVersion: string;
  pausedPlayerIds: string[];
  matches: DomainMatch[];
  version: number;
  startedAt?: string;
  pausedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface StartTournamentResult {
  tournament: TournamentState;
  schedule?: Schedule;
  nextMatch?: NextMatchResult | null;
}

function parseInstant(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!isValidInstant(value) || !Number.isFinite(timestamp)) throw new Error(`${field} must be a valid ISO-8601 instant.`);
  return timestamp;
}

function requireTransition(status: TournamentStatus, allowed: readonly TournamentStatus[], action: string): void {
  if (!allowed.includes(status)) throw new Error(`Cannot ${action} a tournament in ${status} state.`);
}

function requireMatchTransition(match: DomainMatch, allowed: readonly MatchStatus[], action: string): void {
  if (!allowed.includes(match.status)) throw new Error(`Cannot ${action} a match in ${match.status} state.`);
}

function scoreSides(match: DomainMatch, scores: readonly [number, number], now: string, correction: boolean): DomainMatch {
  assertValidScore(scores[0], '/scores/0');
  assertValidScore(scores[1], '/scores/1');
  const timestamp = parseInstant(now, 'now');
  if (match.startTime && timestamp < parseInstant(match.startTime, 'startTime')) {
    throw new Error('Match end time cannot be earlier than start time.');
  }
  if (correction && match.endTime && timestamp < parseInstant(match.endTime, 'endTime')) {
    throw new Error('A score correction cannot move the completion time backwards.');
  }
  return {
    ...match,
    status: 'completed',
    sides: [
      { ...match.sides[0], score: scores[0] },
      { ...match.sides[1], score: scores[1] },
    ],
    endTime: correction ? match.endTime! : now,
    version: match.version + 1,
  };
}

export function startTournament(tournament: TournamentState, now: string): StartTournamentResult {
  requireTransition(tournament.status, ['draft'], 'start');
  parseInstant(now, 'now');
  assertValidTournamentInput(tournament.mode, tournament.participants, {
    ...(tournament.fixedTeams ? { fixedTeams: tournament.fixedTeams } : {}),
    seed: tournament.seed,
    generatorVersion: tournament.generatorVersion,
  });
  const base: TournamentState = {
    ...tournament,
    status: 'active',
    participants: tournament.participants.map((participant) => ({ ...participant })),
    pausedPlayerIds: [],
    matches: [],
    startedAt: now,
    version: tournament.version + 1,
  };
  if (tournament.mode === '2v2_rotating') {
    const nextMatch = generateNextRotatingMatch([], tournament.participants, [], tournament.seed, tournament.generatorVersion);
    return {
      tournament: { ...base, matches: nextMatch ? [nextMatch.match] : [] },
      nextMatch,
    };
  }
  const schedule = generateSchedule(tournament.mode, tournament.participants, tournament.seed, {
    fixedTeams: tournament.fixedTeams,
    generatorVersion: tournament.generatorVersion,
  });
  return {
    tournament: { ...base, matches: schedule.rounds.flatMap((round) => round.matches) },
    schedule,
  };
}

export function pauseTournament(tournament: TournamentState, now: string): TournamentState {
  requireTransition(tournament.status, ['active'], 'pause');
  const timestamp = parseInstant(now, 'now');
  if (tournament.startedAt && timestamp < parseInstant(tournament.startedAt, 'startedAt')) {
    throw new Error('Tournament pause time cannot precede its start.');
  }
  return { ...tournament, status: 'paused', pausedAt: now, version: tournament.version + 1 };
}

export function resumeTournament(tournament: TournamentState, now: string): TournamentState {
  requireTransition(tournament.status, ['paused'], 'resume');
  const timestamp = parseInstant(now, 'now');
  if (tournament.pausedAt && timestamp < parseInstant(tournament.pausedAt, 'pausedAt')) {
    throw new Error('Tournament resume time cannot precede its pause.');
  }
  const { pausedAt: _pausedAt, ...rest } = tournament;
  return { ...rest, status: 'active', version: tournament.version + 1 };
}

export function finishTournament(tournament: TournamentState, now: string): TournamentState {
  requireTransition(tournament.status, ['active', 'paused'], 'finish');
  const timestamp = parseInstant(now, 'now');
  if (tournament.startedAt && timestamp < parseInstant(tournament.startedAt, 'startedAt')) {
    throw new Error('Tournament completion time cannot precede its start.');
  }
  if (tournament.pausedAt && timestamp < parseInstant(tournament.pausedAt, 'pausedAt')) {
    throw new Error('Tournament completion time cannot precede its pause.');
  }
  const { pausedAt: _pausedAt, ...rest } = tournament;
  return { ...rest, status: 'completed', completedAt: now, version: tournament.version + 1 };
}

export function cancelTournament(tournament: TournamentState, now: string): TournamentState {
  requireTransition(tournament.status, ['active', 'paused'], 'cancel');
  const timestamp = parseInstant(now, 'now');
  if (tournament.startedAt && timestamp < parseInstant(tournament.startedAt, 'startedAt')) {
    throw new Error('Tournament cancellation time cannot precede its start.');
  }
  if (tournament.pausedAt && timestamp < parseInstant(tournament.pausedAt, 'pausedAt')) {
    throw new Error('Tournament cancellation time cannot precede its pause.');
  }
  const { pausedAt: _pausedAt, ...rest } = tournament;
  return { ...rest, status: 'cancelled', cancelledAt: now, version: tournament.version + 1 };
}

export function updatePlayerAvailability(
  tournament: TournamentState,
  pausedPlayerIds: readonly string[],
  currentMatch: DomainMatch | undefined,
  now: string,
): { pausedPlayerIds: string[]; match?: DomainMatch } {
  requireTransition(tournament.status, ['active', 'paused'], 'update player availability in');
  parseInstant(now, 'now');
  const rosterIds = new Set(tournament.participants.map((participant) => participant.id));
  if (pausedPlayerIds.length > tournament.participants.length) throw new Error('Paused participant set cannot exceed the roster size.');
  const next = new Set(pausedPlayerIds);
  if (next.size !== pausedPlayerIds.length) throw new Error('Paused participant IDs must be unique.');
  pausedPlayerIds.forEach((id) => {
    if (!rosterIds.has(id)) throw new Error(`Paused participant ${id} is not in this tournament.`);
  });
  const newlyPaused = pausedPlayerIds.filter((id) => !tournament.pausedPlayerIds.includes(id));
  if (tournament.status !== 'paused' && currentMatch?.status === 'in_progress') {
    const currentPlayers = new Set(currentMatch.sides.flatMap((side) => side.players.map((player) => player.id)));
    if (newlyPaused.some((id) => currentPlayers.has(id))) {
      const pausedMatch = pauseMatch(currentMatch, 'active', now, 'participant_unavailable');
      return { pausedPlayerIds: Array.from(next).sort(), match: pausedMatch };
    }
  }
  return { pausedPlayerIds: Array.from(next).sort() };
}

export function startMatch(
  match: DomainMatch,
  tournamentStatus: TournamentStatus,
  pausedPlayerIds: readonly string[],
  matches: readonly DomainMatch[],
  now: string,
): DomainMatch {
  requireTransition(tournamentStatus, ['active'], 'start a match in');
  requireMatchTransition(match, ['scheduled'], 'start');
  parseInstant(now, 'now');
  if (matches.some((other) => other.id !== match.id && (other.status === 'in_progress' || other.status === 'paused'))) {
    throw new Error('Only one match may be in progress or paused at a time.');
  }
  if (matches.some((other) => other.sequence < match.sequence && other.status !== 'completed' && other.status !== 'skipped')) {
    throw new Error('Earlier scheduled matches must be completed or skipped first.');
  }
  const paused = new Set(pausedPlayerIds);
  if (match.sides.some((side) => side.players.some((player) => paused.has(player.id)))) {
    throw new Error('A match containing a paused participant cannot start.');
  }
  return { ...match, status: 'in_progress', startTime: now, version: match.version + 1 };
}

export function pauseMatch(
  match: DomainMatch,
  tournamentStatus: TournamentStatus,
  now: string,
  reason: MatchPauseInterval['reason'] = 'organizer',
): DomainMatch {
  requireTransition(tournamentStatus, ['active'], 'pause a match in');
  requireMatchTransition(match, ['in_progress'], 'pause');
  parseInstant(now, 'now');
  if (match.startTime && Date.parse(now) < Date.parse(match.startTime)) throw new Error('Pause time cannot precede match start.');
  const pauseInterval: MatchPauseInterval = { pausedAt: now, resumedAt: null, reason };
  return { ...match, status: 'paused', pauseIntervals: match.pauseIntervals.concat(pauseInterval), version: match.version + 1 };
}

export function resumeMatch(
  match: DomainMatch,
  tournamentStatus: TournamentStatus,
  pausedPlayerIds: readonly string[],
  now: string,
): DomainMatch {
  requireTransition(tournamentStatus, ['active'], 'resume a match in');
  requireMatchTransition(match, ['paused'], 'resume');
  const timestamp = parseInstant(now, 'now');
  const activePlayers = new Set(match.sides.flatMap((side) => side.players.map((player) => player.id)));
  if (pausedPlayerIds.some((id) => activePlayers.has(id))) throw new Error('A match cannot resume while one of its participants is paused.');
  const intervals = match.pauseIntervals.slice();
  const openIndex = intervals.findIndex((interval) => interval.resumedAt === null);
  if (openIndex < 0) throw new Error('Paused match must have an open pause interval.');
  const openInterval = intervals[openIndex]!;
  if (timestamp < parseInstant(openInterval.pausedAt, 'pausedAt')) throw new Error('Resume time cannot precede pause time.');
  intervals[openIndex] = { ...openInterval, resumedAt: now };
  return { ...match, status: 'in_progress', pauseIntervals: intervals, version: match.version + 1 };
}

export function completeMatch(
  match: DomainMatch,
  scores: readonly [number, number],
  tournamentStatus: TournamentStatus,
  now: string,
  pausedPlayerIds: readonly string[] = [],
): DomainMatch {
  requireTransition(tournamentStatus, ['active'], 'record a result in');
  requireMatchTransition(match, ['in_progress'], 'complete');
  const participants = new Set(match.sides.flatMap((side) => side.players.map((player) => player.id)));
  if (pausedPlayerIds.some((id) => participants.has(id))) {
    throw new Error('A match containing a paused participant cannot be completed.');
  }
  return scoreSides(match, scores, now, false);
}

export function correctMatchScore(
  match: DomainMatch,
  scores: readonly [number, number],
  tournamentStatus: TournamentStatus,
  correctedAt: string,
): DomainMatch {
  requireTransition(tournamentStatus, ['active'], 'correct a result in');
  requireMatchTransition(match, ['completed'], 'correct');
  return scoreSides(match, scores, correctedAt, true);
}

export function skipMatch(match: DomainMatch, tournamentStatus: TournamentStatus, now: string): DomainMatch {
  requireTransition(tournamentStatus, ['active'], 'skip a match in');
  requireMatchTransition(match, ['scheduled', 'in_progress', 'paused'], 'skip');
  const timestamp = parseInstant(now, 'now');
  if (match.startTime && timestamp < parseInstant(match.startTime, 'startTime')) {
    throw new Error('Skip time cannot precede match start.');
  }
  const pauseIntervals = match.pauseIntervals.map((interval) => {
    if (interval.resumedAt !== null) return interval;
    if (timestamp < parseInstant(interval.pausedAt, 'pausedAt')) throw new Error('Skip time cannot precede pause time.');
    return { ...interval, resumedAt: now };
  });
  const { endTime: _endTime, ...matchWithoutEndTime } = match;
  const skipped: DomainMatch = {
    ...matchWithoutEndTime,
    status: 'skipped',
    pauseIntervals,
    sides: [
      { ...match.sides[0], score: null },
      { ...match.sides[1], score: null },
    ],
    version: match.version + 1,
  };
  return skipped;
}

export function isStandingsResult(match: DomainMatch): boolean {
  return match.status === 'completed'
    && match.sides.length === 2
    && match.sides[0].score !== null
    && match.sides[1].score !== null;
}
