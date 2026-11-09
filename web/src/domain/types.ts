export const GENERATOR_VERSION = '1';
export const MAX_PARTICIPANTS = 32;
export const MAX_SCORE = 1_000_000;

export type TournamentMode = '1v1' | '2v2_fixed' | '2v2_rotating';
export type TournamentStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
export type MatchStatus = 'scheduled' | 'in_progress' | 'paused' | 'completed' | 'skipped';
export type StandingsView = 'players' | 'teams';

export interface Participant {
  id: string;
  name: string;
}

export interface FixedTeam {
  id: string;
  name: string;
  playerIds: readonly [string, string];
}

export interface MatchSide {
  id: string;
  players: Participant[];
  score: number | null;
  fixedTeamId?: string;
  fixedTeamName?: string;
}

export interface MatchPauseInterval {
  pausedAt: string;
  resumedAt: string | null;
  reason: 'organizer' | 'participant_unavailable';
}

export interface DomainMatch {
  id: string;
  round: number;
  sequence: number;
  status: MatchStatus;
  sides: [MatchSide, MatchSide];
  startTime?: string;
  endTime?: string;
  pauseIntervals: MatchPauseInterval[];
  version: number;
}

export interface ByeEvent {
  subjectType: 'player' | 'fixed_team';
  subjectId: string;
}

export interface ScheduleRound {
  round: number;
  matches: DomainMatch[];
  byeEvents: ByeEvent[];
  restPlayerIds: string[];
}

export interface Schedule {
  mode: '1v1' | '2v2_fixed';
  seed: string;
  generatorVersion: string;
  rounds: ScheduleRound[];
}

export interface NextMatchResult {
  match: DomainMatch;
  restPlayerIds: string[];
}

export interface StandingStats {
  matchesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifferential: number;
}

export type StandingSubjectType = 'player' | 'single_player_side' | 'fixed_team' | 'rotating_pair';

export interface StandingRow extends StandingStats {
  rank: number;
  key: string;
  subjectType: StandingSubjectType;
  name: string;
  playerIds: string[];
  teamId?: string;
}

export interface TournamentStandings {
  players: StandingRow[];
  teams: StandingRow[];
}

export interface OverallTournamentHistory {
  mode: TournamentMode;
  participants: readonly Participant[];
  matches: readonly DomainMatch[];
  fixedTeams?: readonly FixedTeam[];
}

export interface OverallStandingsInput {
  tournaments: readonly OverallTournamentHistory[];
  players?: readonly Participant[];
}

export interface OverallStandings {
  players: StandingRow[];
  teams: StandingRow[];
}

export interface DomainIssue {
  path: string;
  code: string;
  message: string;
}

export class DomainValidationError extends Error {
  readonly issues: DomainIssue[];

  constructor(issues: DomainIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'DomainValidationError';
    this.issues = issues;
  }
}
