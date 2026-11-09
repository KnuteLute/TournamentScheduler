import {
  DomainIssue,
  DomainMatch,
  DomainValidationError,
  FixedTeam,
  MAX_PARTICIPANTS,
  MAX_SCORE,
  Participant,
  TournamentMode,
} from './types';

export function normalizeDisplayName(value: string): string {
  return value.normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()
    .replace(/\u00df/gu, 'ss')
    .replace(/\u03c2/gu, '\u03c3')
    .replace(/\u0345/gu, '\u03b9');
}

export function isValidInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function add(issues: DomainIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

export function validateSeed(seed: string, generatorVersion: string): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 128) {
    add(issues, '/seed', 'invalid_seed', 'Seed must contain between 1 and 128 characters.');
  }
  if (typeof generatorVersion !== 'string' || generatorVersion.length < 1 || generatorVersion.length > 64) {
    add(issues, '/generatorVersion', 'invalid_generator_version', 'Generator version must contain between 1 and 64 characters.');
  }
  return issues;
}

export function validateRoster(participants: readonly Participant[], minimum: number): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (!Array.isArray(participants)) {
    add(issues, '/participants', 'invalid_roster', 'Participants must be an array.');
    return issues;
  }
  if (participants.length < minimum) {
    add(issues, '/participants', 'too_few_participants', `At least ${minimum} distinct participants are required.`);
  }
  if (participants.length > MAX_PARTICIPANTS) {
    add(issues, '/participants', 'too_many_participants', `At most ${MAX_PARTICIPANTS} participants are supported.`);
    return issues;
  }

  const ids = new Set<string>();
  const names = new Map<string, number>();
  participants.forEach((participant, index) => {
    const path = `/participants/${index}`;
    if (!participant || typeof participant !== 'object') {
      add(issues, path, 'invalid_participant', 'Participant must be an object.');
      return;
    }
    if (typeof participant.id !== 'string' || participant.id.length < 1 || participant.id.length > 128) {
      add(issues, `${path}/id`, 'invalid_id', 'Participant ID must contain between 1 and 128 characters.');
    } else if (ids.has(participant.id)) {
      add(issues, `${path}/id`, 'duplicate_participant', 'Participant IDs must be unique.');
    } else {
      ids.add(participant.id);
    }
    if (typeof participant.name !== 'string' || participant.name.trim().length < 1 || participant.name.length > 80) {
      add(issues, `${path}/name`, 'invalid_name', 'Participant name must be non-empty and at most 80 characters.');
    } else {
      const normalized = normalizeDisplayName(participant.name);
      const firstIndex = names.get(normalized);
      if (firstIndex !== undefined) {
        add(issues, `${path}/name`, 'duplicate_name', `Name duplicates participant at index ${firstIndex}.`);
      } else {
        names.set(normalized, index);
      }
    }
  });
  return issues;
}

export function validateFixedTeams(
  participants: readonly Participant[],
  teams: readonly FixedTeam[],
): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (!Array.isArray(participants)) {
    add(issues, '/participants', 'invalid_roster', 'Participants must be an array.');
    return issues;
  }
  const rosterIds = new Set(participants
    .filter((participant) => participant && typeof participant.id === 'string')
    .map((participant) => participant.id));
  if (!Array.isArray(teams)) {
    add(issues, '/fixedTeams', 'invalid_fixed_teams', 'Fixed teams must be an array.');
    return issues;
  }
  if (teams.length > MAX_PARTICIPANTS / 2) {
    add(issues, '/fixedTeams', 'too_many_teams', `At most ${MAX_PARTICIPANTS / 2} fixed teams are supported.`);
    return issues;
  }
  if (teams.length < 2) add(issues, '/fixedTeams', 'too_few_teams', 'At least two fixed teams are required.');
  if (participants.length % 2 !== 0) {
    add(issues, '/participants', 'odd_fixed_roster', 'Fixed teams require an even roster; unmatched players are not permitted.');
  }

  const teamIds = new Set<string>();
  const assignedPlayers = new Set<string>();
  teams.forEach((team, index) => {
    const path = `/fixedTeams/${index}`;
    if (!team || typeof team !== 'object') {
      add(issues, path, 'invalid_fixed_team', 'Fixed team must be an object.');
      return;
    }
    if (typeof team.id !== 'string' || team.id.length < 1 || team.id.length > 128 || teamIds.has(team.id)) {
      add(issues, `${path}/id`, 'invalid_team_id', 'Fixed-team IDs must be non-empty, bounded, and unique.');
    }
    teamIds.add(team.id);
    if (typeof team.name !== 'string' || team.name.trim().length < 1 || team.name.length > 80) {
      add(issues, `${path}/name`, 'invalid_team_name', 'Fixed-team name must be non-empty and at most 80 characters.');
    }
    if (!Array.isArray(team.playerIds) || team.playerIds.length !== 2 || team.playerIds[0] === team.playerIds[1]) {
      add(issues, `${path}/playerIds`, 'invalid_team_members', 'Each fixed team must contain exactly two distinct players.');
      return;
    }
    team.playerIds.forEach((playerId: string) => {
      if (!rosterIds.has(playerId)) {
        add(issues, `${path}/playerIds`, 'unknown_team_member', 'Every fixed-team member must be in the tournament roster.');
      }
      if (assignedPlayers.has(playerId)) {
        add(issues, `${path}/playerIds`, 'duplicate_team_member', 'A participant may belong to only one fixed team.');
      }
      assignedPlayers.add(playerId);
    });
  });
  if (assignedPlayers.size !== rosterIds.size || [...rosterIds].some((id) => !assignedPlayers.has(id))) {
    add(issues, '/fixedTeams', 'incomplete_team_partition', 'Fixed teams must partition the complete tournament roster.');
  }
  return issues;
}

export function validateTournamentInput(
  mode: TournamentMode,
  participants: readonly Participant[],
  options: { fixedTeams?: readonly FixedTeam[]; seed?: string; generatorVersion?: string } = {},
): DomainIssue[] {
  const minimum = mode === '1v1' ? 2 : 4;
  const issues = validateRoster(participants, minimum);
  if (!['1v1', '2v2_fixed', '2v2_rotating'].includes(mode)) {
    add(issues, '/mode', 'invalid_mode', 'Tournament mode is not supported.');
  }
  if (mode === '2v2_fixed') {
    if (!options.fixedTeams) add(issues, '/fixedTeams', 'missing_fixed_teams', 'Fixed-team mode requires an explicit team partition.');
    else if (Array.isArray(participants)) issues.push(...validateFixedTeams(participants, options.fixedTeams));
  } else if (options.fixedTeams && options.fixedTeams.length > 0) {
    add(issues, '/fixedTeams', 'unexpected_fixed_teams', 'Fixed-team assignments are valid only in fixed-team mode.');
  }
  if (options.seed !== undefined || options.generatorVersion !== undefined) {
    issues.push(...validateSeed(options.seed ?? '', options.generatorVersion ?? ''));
  }
  return issues;
}

export function assertValidTournamentInput(
  mode: TournamentMode,
  participants: readonly Participant[],
  options: { fixedTeams?: readonly FixedTeam[]; seed?: string; generatorVersion?: string } = {},
): void {
  const issues = validateTournamentInput(mode, participants, options);
  if (issues.length > 0) throw new DomainValidationError(issues);
}

export function validateScore(value: unknown, path = '/score'): DomainIssue[] {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0 || value > MAX_SCORE) {
    return [{ path, code: 'invalid_score', message: `Score must be an integer from 0 to ${MAX_SCORE}.` }];
  }
  return [];
}

export function assertValidScore(value: unknown, path = '/score'): asserts value is number {
  const issues = validateScore(value, path);
  if (issues.length > 0) throw new DomainValidationError(issues);
}

export function validateMatch(
  match: DomainMatch,
  mode: TournamentMode,
  participants: readonly Participant[],
  fixedTeams: readonly FixedTeam[] = [],
): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const rosterIds = new Set(participants.map((participant) => participant.id));
  if (mode === '2v2_fixed' && fixedTeams.length === 0) {
    add(issues, '/fixedTeams', 'missing_fixed_teams', 'Fixed-team match validation requires configured tournament teams.');
  }
  if (!match || !Array.isArray(match.sides) || match.sides.length !== 2) {
    add(issues, '/sides', 'invalid_sides', 'A match must have exactly two sides.');
    return issues;
  }
  const expectedSize = mode === '1v1' ? 1 : 2;
  const seen = new Set<string>();
  const seenFixedTeams = new Set<string>();
  const fixedTeamById = new Map(fixedTeams.map((team) => [team.id, team]));
  match.sides.forEach((side, sideIndex) => {
    const path = `/sides/${sideIndex}`;
    if (!side || typeof side !== 'object') {
      add(issues, path, 'invalid_side', 'Match side must be an object.');
      return;
    }
    if (!Array.isArray(side.players)) {
      add(issues, `${path}/players`, 'invalid_side_players', 'Side participants must be an array.');
      return;
    }
    if (side.players.length !== expectedSize) {
      add(issues, `${path}/players`, 'invalid_side_size', `Each side must contain ${expectedSize} participant(s).`);
    }
    side.players.forEach((player) => {
      if (!player || typeof player !== 'object' || typeof player.id !== 'string') {
        add(issues, `${path}/players`, 'invalid_match_participant', 'Match participants must have a valid ID.');
        return;
      }
      if (!rosterIds.has(player.id)) add(issues, `${path}/players`, 'unknown_participant', 'Match participants must belong to the tournament roster.');
      if (seen.has(player.id)) add(issues, `${path}/players`, 'duplicate_match_participant', 'A participant may appear only once in a match.');
      seen.add(player.id);
    });
    if (mode === '2v2_fixed') {
      const fixedTeam = side.fixedTeamId ? fixedTeamById.get(side.fixedTeamId) : undefined;
      if (!fixedTeam) {
        add(issues, `${path}/fixedTeamId`, 'unknown_fixed_team', 'Fixed-team match sides must identify a configured tournament team.');
      } else {
        if (seenFixedTeams.has(fixedTeam.id)) {
          add(issues, `${path}/fixedTeamId`, 'duplicate_fixed_team', 'The same fixed team cannot occupy both sides.');
        }
        seenFixedTeams.add(fixedTeam.id);
        const actualIds = side.players
          .filter((player) => player && typeof player.id === 'string')
          .map((player) => player.id)
          .sort();
        const configuredIds = fixedTeam.playerIds.slice().sort();
        if (actualIds[0] !== configuredIds[0] || actualIds[1] !== configuredIds[1]) {
          add(issues, `${path}/players`, 'fixed_team_membership_mismatch', 'Match participants must match the configured fixed team.');
        }
      }
    }
    if (side.score !== null) issues.push(...validateScore(side.score, `${path}/score`));
  });
  if (match.status === 'completed' && match.sides.some((side) => !side || side.score === null)) {
    add(issues, '/sides', 'missing_completed_score', 'Completed matches require both scores.');
  }
  if (match.status !== 'completed' && match.sides.some((side) => side && side.score !== null)) {
    add(issues, '/sides', 'unexpected_score', 'Only completed matches may have scores.');
  }
  if ((match.status === 'completed') !== (match.endTime !== undefined)) {
    add(issues, '/endTime', 'invalid_end_time', 'An end time is present if and only if a match is completed.');
  }
  if (match.startTime !== undefined && !isValidInstant(match.startTime)) {
    add(issues, '/startTime', 'invalid_start_time', 'Start time must be an ISO-8601 instant with a timezone.');
  }
  if (match.endTime !== undefined && !isValidInstant(match.endTime)) {
    add(issues, '/endTime', 'invalid_end_time', 'End time must be an ISO-8601 instant with a timezone.');
  }
  if (match.status === 'scheduled' && match.startTime !== undefined) {
    add(issues, '/startTime', 'scheduled_match_started', 'A scheduled match cannot have a start time.');
  }
  if (match.startTime && match.endTime && Date.parse(match.endTime) < Date.parse(match.startTime)) {
    add(issues, '/endTime', 'invalid_match_timing', 'End time cannot precede start time.');
  }
  if (!Array.isArray(match.pauseIntervals)) {
    add(issues, '/pauseIntervals', 'invalid_pause_intervals', 'Pause intervals must be an array.');
  } else {
    const openPauseCount = match.pauseIntervals.filter((interval) => interval && interval.resumedAt === null).length;
    if ((match.status === 'paused') !== (openPauseCount === 1)) {
      add(issues, '/pauseIntervals', 'invalid_open_pause', 'An open pause interval is present if and only if a match is paused.');
    }
    match.pauseIntervals.forEach((interval, index) => {
      const path = `/pauseIntervals/${index}`;
      if (!interval || typeof interval !== 'object') {
        add(issues, path, 'invalid_pause_interval', 'Pause interval must be an object.');
        return;
      }
      if (!isValidInstant(interval.pausedAt)
        || (interval.resumedAt !== null && !isValidInstant(interval.resumedAt))) {
        add(issues, path, 'invalid_pause_time', 'Pause interval times must be ISO-8601 instants with a timezone.');
      } else if (interval.resumedAt !== null && Date.parse(interval.resumedAt) < Date.parse(interval.pausedAt)) {
        add(issues, `${path}/resumedAt`, 'invalid_pause_order', 'Resume time cannot precede pause time.');
      }
    });
  }
  return issues;
}

export function assertValidMatch(
  match: DomainMatch,
  mode: TournamentMode,
  participants: readonly Participant[],
  fixedTeams: readonly FixedTeam[] = [],
): void {
  const issues = validateMatch(match, mode, participants, fixedTeams);
  if (issues.length > 0) throw new DomainValidationError(issues);
}
