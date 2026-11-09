export type Id = string
export type TournamentMode = '1v1' | '2v2_fixed' | '2v2_rotating'
export type TournamentStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled'
export type MatchStatus = 'scheduled' | 'in_progress' | 'paused' | 'completed' | 'skipped'
export type StandingsView = 'players' | 'teams'

export interface Session {
  kind: 'guest' | 'authenticated'
  account: { id: Id; username: string } | null
  csrfToken: string
  expiresAt: string
  pendingGuestClaim: boolean
}

export interface TransferSummary {
  status: 'none' | 'transferred' | 'pending_conflicts'
  playersTransferred: number
  teamsTransferred: number
  tournamentsTransferred: number
  conflicts: GuestNameConflict[]
}

export interface GuestNameConflict {
  entityKind: 'player' | 'team'
  resourceId: Id
  displayName: string
  collisionNames: string[]
}

export interface PendingGuestClaim {
  pending: true
  conflicts: TransferSummary['conflicts']
}

export interface AuthResult {
  session: Session
  transfer: TransferSummary
}

export interface Player {
  id: Id
  name: string
  createdAt: string
  updatedAt: string
}

export interface PlayerSummary {
  id: Id
  name: string
}

export interface Team {
  id: Id
  name: string
  players: PlayerSummary[]
  createdAt: string
  updatedAt: string
}

export interface TournamentParticipant {
  id: Id
  name: string
  kind: 'player' | 'team'
  players?: PlayerSummary[]
}

export interface Tournament {
  id: Id
  name: string
  mode: TournamentMode
  status: TournamentStatus
  participants: TournamentParticipant[]
  pausedPlayerIds: Id[]
  version: number
  seed: string
  generatorVersion: string
  currentMatchId?: Id | null
  startedAt?: string | null
  pausedAt?: string | null
  completedAt?: string | null
  cancelledAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface MatchSide {
  participantId: Id
  name: string
  players: PlayerSummary[]
  score: number | null
}

export interface Match {
  id: Id
  round: number
  sequence: number
  status: MatchStatus
  sides: [MatchSide, MatchSide]
  version: number
  createdAt: string
  winnerSide: 1 | 2 | null
  pauseIntervals: { pausedAt: string; resumedAt: string | null; reason: 'organizer' | 'participant_unavailable' }[]
  startTime?: string | null
  endTime?: string | null
}

export interface Schedule {
  tournamentId: Id
  seed: string
  generatorVersion: string
  rounds: {
    round: number
    matchIds: Id[]
    byeEvents: { subjectType: 'player' | 'fixed_team'; subjectId: Id }[]
    restPlayerIds: Id[]
  }[]
}

export interface StandingRow {
  rank: number
  subjectType: 'player' | 'single_player_side' | 'fixed_team' | 'rotating_pair'
  name: string
  playerIds: Id[]
  teamId?: Id
  matchesPlayed: number
  wins: number
  draws: number
  losses: number
  pointsFor: number
  pointsAgainst: number
  pointDifferential: number
}

export interface Standings {
  scope: 'tournament' | 'overall'
  view: StandingsView
  tournamentId: Id | null
  tournamentVersion: number | null
  rows: StandingRow[]
  calculatedAt: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface Problem {
  type?: string
  title?: string
  status?: number
  detail?: string
  instance?: string
  code?: string
  traceId?: string
  errors?: { pointer: string; code: string; message: string }[]
}
