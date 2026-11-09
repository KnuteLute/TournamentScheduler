/**
 * Shared persistence value types. The API data-store port is owned by
 * `web/src/services/ports.ts`; persistence adapters import and implement that
 * interface rather than declaring a competing repository contract here.
 */

export type UUID = string;

export interface OwnerScope {
  readonly ownerId: UUID;
  readonly actor: 'user' | 'guest' | 'system';
  readonly userId?: number;
  readonly guestSessionId?: UUID;
}

export interface UserRecord {
  id: number;
  username: string;
  usernameKey: string | null;
  passwordHash: string;
  createdAt: Date;
  disabledAt: Date | null;
}

export interface SessionRecord {
  id: UUID;
  userId: number | null;
  guestSessionId: UUID | null;
  ownerId: UUID;
  expiresAt: Date;
  revokedAt: Date | null;
  claimedAt?: Date | null;
}

export interface PlayerRecord {
  id: number;
  ownerId: UUID;
  name: string;
  nameKey: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifferential: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface TeamRecord {
  id: UUID;
  ownerId: UUID;
  name: string;
  nameKey: string;
  playerIds: number[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export type TournamentMode = '1v1' | '2v2_fixed' | '2v2_rotating';
export type TournamentStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';

export interface TournamentRecord {
  id: number;
  publicId: UUID;
  ownerId: UUID;
  mode: TournamentMode;
  status: TournamentStatus;
  version: number;
  seed: string | null;
  generatorVersion: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  deletedAt: Date | null;
}

export type MatchStatus = 'scheduled' | 'in_progress' | 'paused' | 'completed' | 'skipped';

export interface MatchRecord {
  id: number;
  publicId: UUID;
  tournamentId: number;
  sequenceNo: number;
  status: MatchStatus;
  winnerSide: 1 | 2 | null;
  startedAt: Date | null;
  completedAt: Date | null;
  sides: Array<{
    sideNo: 1 | 2;
    score: number | null;
    players: Array<{ playerId: number | null; nameSnapshot: string; position: number }>;
  }>;
}

export interface IdempotencyInput {
  ownerId: UUID;
  operation: string;
  key: string;
  requestHash: string;
}

export interface IdempotencyRecord extends IdempotencyInput {
  status: 'in_progress' | 'completed';
  response: unknown | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface AuditEventInput {
  ownerId: UUID | null;
  actorType: 'user' | 'guest' | 'system' | 'legacy';
  userId?: number | null;
  guestSessionId?: UUID | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PlayerCreateInput {
  name: string;
  nameKey: string;
}

export interface TeamCreateInput {
  name: string;
  nameKey: string;
  playerIds: [number, number];
}
