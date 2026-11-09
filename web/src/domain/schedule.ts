import { compareText, hash32, seededOrder, seededShuffle } from './random';
import { assertValidTournamentInput } from './validation';
import {
  DomainMatch,
  FixedTeam,
  GENERATOR_VERSION,
  MatchSide,
  NextMatchResult,
  Participant,
  Schedule,
  ScheduleRound,
  TournamentMode,
} from './types';

type RotatingPair = [string, string];

interface FairnessStats {
  appearances: number;
  waiting: number;
  consecutive: number;
}

interface PairingPlan {
  players: string[];
  pairs: [RotatingPair, RotatingPair];
  repeatCost: number;
  hasOnlyNovelPairs: boolean;
  tieKey: string;
}

function compareIds(left: string, right: string): number {
  return compareText(left, right);
}

function participantMap(participants: readonly Participant[]): Map<string, Participant> {
  return new Map(participants.map((participant) => [participant.id, { ...participant }]));
}

function makeMatch(
  id: string,
  round: number,
  sequence: number,
  sideOne: MatchSide,
  sideTwo: MatchSide,
): DomainMatch {
  return {
    id,
    round,
    sequence,
    status: 'scheduled',
    sides: [sideOne, sideTwo],
    pauseIntervals: [],
    version: 1,
  };
}

function playerSide(player: Participant, sideId: string): MatchSide {
  return { id: sideId, players: [{ ...player }], score: null };
}

function teamSide(
  playerIds: readonly string[],
  players: Map<string, Participant>,
  sideId: string,
  fixedTeam?: FixedTeam,
): MatchSide {
  const side: MatchSide = {
    id: sideId,
    players: playerIds.map((id) => ({ ...players.get(id)! })),
    score: null,
  };
  if (fixedTeam) {
    side.fixedTeamId = fixedTeam.id;
    side.fixedTeamName = fixedTeam.name;
  }
  return side;
}

function roundRobin<T>(items: readonly T[], seed: string, namespace: string): Array<{ pairs: Array<[T, T]>; bye: T | null }> {
  const shuffled = seededShuffle(items, seed, namespace);
  const circle: Array<T | null> = shuffled.slice();
  if (circle.length % 2 !== 0) circle.push(null);
  const rounds: Array<{ pairs: Array<[T, T]>; bye: T | null }> = [];

  for (let roundIndex = 0; roundIndex < circle.length - 1; roundIndex += 1) {
    const pairs: Array<[T, T]> = [];
    let bye: T | null = null;
    for (let slot = 0; slot < circle.length / 2; slot += 1) {
      const left = circle[slot]!;
      const right = circle[circle.length - 1 - slot]!;
      if (left === null) bye = right;
      else if (right === null) bye = left;
      else pairs.push([left, right]);
    }
    rounds.push({ pairs, bye });
    const last = circle.pop()!;
    circle.splice(1, 0, last);
  }
  return rounds;
}

export function generate1v1RoundRobin(
  participants: readonly Participant[],
  seed: string,
  generatorVersion = GENERATOR_VERSION,
): Schedule {
  assertValidTournamentInput('1v1', participants, { seed, generatorVersion });
  const canonicalPlayers = participants.slice().sort((left, right) => compareIds(left.id, right.id));
  const generatedRounds = roundRobin(canonicalPlayers, seed, `1v1:${generatorVersion}`);
  const rounds: ScheduleRound[] = generatedRounds.map((generated, roundIndex) => {
    const round = roundIndex + 1;
    const matches = generated.pairs.map(([first, second], slotIndex) => {
      const [left, right] = seededOrder(
        [first, second],
        seed,
        `1v1-side:${generatorVersion}:${round}:${slotIndex}`,
        (player) => player.id,
      );
      return makeMatch(
        `rr-1v1-r${round}-m${slotIndex + 1}`,
        round,
        (round - 1) * Math.max(1, Math.floor(canonicalPlayers.length / 2)) + slotIndex + 1,
        playerSide(left!, `single:${left!.id}`),
        playerSide(right!, `single:${right!.id}`),
      );
    });
    return {
      round,
      matches,
      byeEvents: generated.bye ? [{ subjectType: 'player', subjectId: generated.bye.id }] : [],
      restPlayerIds: [],
    };
  });
  return { mode: '1v1', seed, generatorVersion, rounds };
}

export function generateFixedTeamRoundRobin(
  participants: readonly Participant[],
  fixedTeams: readonly FixedTeam[],
  seed: string,
  generatorVersion = GENERATOR_VERSION,
): Schedule {
  assertValidTournamentInput('2v2_fixed', participants, { fixedTeams, seed, generatorVersion });
  const playerMap = participantMap(participants);
  const teamMap = new Map(fixedTeams.map((team) => [team.id, team]));
  const canonicalTeams = fixedTeams
    .map((team) => ({ ...team, playerIds: team.playerIds.slice().sort(compareIds) as [string, string] }))
    .sort((left, right) => compareIds(left.id, right.id));
  const generatedRounds = roundRobin(canonicalTeams, seed, `2v2_fixed:${generatorVersion}`);
  const rounds: ScheduleRound[] = generatedRounds.map((generated, roundIndex) => {
    const round = roundIndex + 1;
    const matches = generated.pairs.map(([first, second], slotIndex) => {
      const orientation = seededOrder(
        [first, second],
        seed,
        `2v2-fixed-side:${generatorVersion}:${round}:${slotIndex}`,
        (team) => team.id,
      );
      const left = orientation[0]!;
      const right = orientation[1]!;
      return makeMatch(
        `rr-2v2f-r${round}-m${slotIndex + 1}`,
        round,
        (round - 1) * Math.max(1, Math.floor(canonicalTeams.length / 2)) + slotIndex + 1,
        teamSide(left.playerIds, playerMap, `fixed:${left.id}`, teamMap.get(left.id)),
        teamSide(right.playerIds, playerMap, `fixed:${right.id}`, teamMap.get(right.id)),
      );
    });
    return {
      round,
      matches,
      byeEvents: generated.bye ? [{ subjectType: 'fixed_team', subjectId: generated.bye.id }] : [],
      restPlayerIds: [],
    };
  });
  return { mode: '2v2_fixed', seed, generatorVersion, rounds };
}

function canonicalPair(first: string, second: string): RotatingPair {
  return compareIds(first, second) < 0 ? [first, second] : [second, first];
}

function pairKey(pair: readonly string[]): string {
  return pair.slice().sort(compareIds).join('\u0000');
}

function matchPlayerIds(match: DomainMatch): string[] {
  return match.sides.flatMap((side) => side.players.map((player) => player.id));
}

function accumulatedHistory(
  participants: readonly Participant[],
  history: readonly DomainMatch[],
): Map<string, FairnessStats> {
  const stats = new Map<string, FairnessStats>();
  const acceptedHistory = history.filter((match) => match.status !== 'skipped');
  participants.forEach((participant) => {
    stats.set(participant.id, { appearances: 0, waiting: acceptedHistory.length + 1, consecutive: 0 });
  });
  const ordered = acceptedHistory
    .slice()
    .sort((left, right) => left.sequence - right.sequence || compareIds(left.id, right.id));

  ordered.forEach((match) => {
    const appeared = new Set(matchPlayerIds(match));
    stats.forEach((playerStats, id) => {
      if (appeared.has(id)) {
        playerStats.appearances += 1;
        playerStats.waiting = 0;
        playerStats.consecutive += 1;
      } else {
        playerStats.waiting += 1;
        playerStats.consecutive = 0;
      }
    });
  });
  return stats;
}

function partnershipCounts(history: readonly DomainMatch[]): { counts: Map<string, number>; currentCycle: Set<string> } {
  const counts = new Map<string, number>();
  const currentCycle = new Set<string>();
  history
    .filter((match) => match.status !== 'skipped')
    .slice()
    .sort((left, right) => left.sequence - right.sequence || compareIds(left.id, right.id))
    .forEach((match) => {
      for (const side of match.sides) {
        if (side.players.length !== 2) continue;
        const key = pairKey(side.players.map((player) => player.id));
        if (currentCycle.has(key)) currentCycle.clear();
        currentCycle.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    });
  return { counts, currentCycle };
}

function compareFairness(left: FairnessStats, right: FairnessStats): number {
  return left.appearances - right.appearances
    || right.waiting - left.waiting
    || left.consecutive - right.consecutive;
}

function compareFairnessMetric(leftId: string, rightId: string, stats: Map<string, FairnessStats>): number {
  return compareFairness(stats.get(leftId)!, stats.get(rightId)!);
}

function enumerateCombinations<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  const current: T[] = [];
  const visit = (offset: number): void => {
    if (current.length === size) {
      output.push(current.slice());
      return;
    }
    const needed = size - current.length;
    for (let index = offset; index <= items.length - needed; index += 1) {
      current.push(items[index]!);
      visit(index + 1);
      current.pop();
    }
  };
  visit(0);
  return output;
}

function bestFairnessQuartets(
  eligibleIds: readonly string[],
  stats: Map<string, FairnessStats>,
): string[][] {
  const ordered = eligibleIds.slice().sort((left, right) => compareFairnessMetric(left, right, stats) || compareIds(left, right));
  const boundaryId = ordered[3]!;
  const strictlyAhead = ordered.filter((id) => compareFairnessMetric(id, boundaryId, stats) < 0);
  const boundary = ordered.filter((id) => compareFairnessMetric(id, boundaryId, stats) === 0);
  const remaining = 4 - strictlyAhead.length;
  return enumerateCombinations(boundary, remaining).map((chosen) => strictlyAhead.concat(chosen));
}

function pairings(players: readonly string[]): Array<[RotatingPair, RotatingPair]> {
  const [a, b, c, d] = players;
  return [
    [canonicalPair(a!, b!), canonicalPair(c!, d!)],
    [canonicalPair(a!, c!), canonicalPair(b!, d!)],
    [canonicalPair(a!, d!), canonicalPair(b!, c!)],
  ];
}

function buildPairingPlans(
  quartets: readonly string[][],
  partnershipHistory: { counts: Map<string, number>; currentCycle: Set<string> },
  seed: string,
  namespace: string,
): PairingPlan[] {
  return quartets.flatMap((quartet) => pairings(quartet).map((pairs) => {
    const pairKeys = pairs.map(pairKey);
    const hasOnlyNovelPairs = pairKeys.every((key) => !partnershipHistory.currentCycle.has(key));
    const repeatCost = pairKeys.reduce((total, key) => total + (partnershipHistory.counts.get(key) ?? 0), 0);
    const playerKey = quartet.slice().sort(compareIds).join('|');
    const partnershipKey = pairKeys.slice().sort(compareIds).join('|');
    return {
      players: quartet.slice().sort(compareIds),
      pairs,
      repeatCost,
      hasOnlyNovelPairs,
      tieKey: `${hash32(`${seed}\u0000${namespace}\u0000${playerKey}\u0000${partnershipKey}`).toString(16).padStart(8, '0')}:${playerKey}:${partnershipKey}`,
    };
  }));
}

export function generateNextRotatingMatch(
  history: readonly DomainMatch[],
  participants: readonly Participant[],
  pausedPlayerIds: readonly string[],
  seed: string,
  generatorVersion = GENERATOR_VERSION,
): NextMatchResult | null {
  assertValidTournamentInput('2v2_rotating', participants, { seed, generatorVersion });
  if (history.some((match) => match.status === 'scheduled' || match.status === 'in_progress' || match.status === 'paused')) {
    throw new Error('Resolve the current rotating match before generating another.');
  }
  const paused = new Set(pausedPlayerIds);
  if (pausedPlayerIds.length > participants.length) throw new Error('Paused participant set cannot exceed the roster size.');
  const rosterIds = new Set(participants.map((participant) => participant.id));
  if (paused.size !== pausedPlayerIds.length) throw new Error('Paused participant IDs must be unique.');
  const unknownPausedIds = pausedPlayerIds.filter((id) => !rosterIds.has(id));
  if (unknownPausedIds.length > 0) {
    throw new Error(`Paused participant IDs must belong to the roster: ${unknownPausedIds.join(', ')}`);
  }
  const eligible = participants
    .filter((participant) => !paused.has(participant.id))
    .map((participant) => participant.id)
    .sort(compareIds);
  if (eligible.length < 4) return null;

  const stats = accumulatedHistory(participants, history);
  const quartets = bestFairnessQuartets(eligible, stats);
  const partnershipHistory = partnershipCounts(history);
  const nextSequence = history.reduce((max, match) => Math.max(max, match.sequence), 0) + 1;
  const acceptedCount = history.reduce((count, match) => count + (match.status === 'skipped' ? 0 : 1), 0);
  const namespace = `rotating:${generatorVersion}:accepted-${acceptedCount + 1}`;
  const plans = buildPairingPlans(quartets, partnershipHistory, seed, namespace);
  const novelPlans = plans.filter((plan) => plan.hasOnlyNovelPairs);
  const candidates = novelPlans.length > 0
    ? novelPlans
    : plans.filter((plan) => plan.repeatCost === Math.min(...plans.map((candidate) => candidate.repeatCost)));
  candidates.sort((left, right) => compareIds(left.tieKey, right.tieKey));
  const chosen = candidates[0]!;
  const playersById = participantMap(participants);
  const pairOrder = seededOrder(
    chosen.pairs,
    seed,
    `${namespace}:sides`,
    (pair) => pairKey(pair),
  );
  const sides: [MatchSide, MatchSide] = [
    teamSide(pairOrder[0]!, playersById, `pair:${pairKey(pairOrder[0]!)}`),
    teamSide(pairOrder[1]!, playersById, `pair:${pairKey(pairOrder[1]!)}`),
  ];
  const match = makeMatch(
    `rot-${nextSequence}-${hash32(`${seed}\u0000${generatorVersion}\u0000${nextSequence}`).toString(16)}`,
    nextSequence,
    nextSequence,
    sides[0],
    sides[1],
  );
  const selectedIds = new Set(chosen.players);
  return {
    match,
    restPlayerIds: eligible.filter((id) => !selectedIds.has(id)),
  };
}

export function generateSchedule(
  mode: Exclude<TournamentMode, '2v2_rotating'>,
  participants: readonly Participant[],
  seed: string,
  options: { fixedTeams?: readonly FixedTeam[] | undefined; generatorVersion?: string } = {},
): Schedule {
  const generatorVersion = options.generatorVersion ?? GENERATOR_VERSION;
  if (mode === '1v1') return generate1v1RoundRobin(participants, seed, generatorVersion);
  if (!options.fixedTeams) throw new Error('Fixed-team mode requires explicit fixedTeams.');
  return generateFixedTeamRoundRobin(participants, options.fixedTeams, seed, generatorVersion);
}
