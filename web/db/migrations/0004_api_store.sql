-- API projections and stable, domain-generated match identifiers.
ALTER TABLE tournaments
  ADD COLUMN name TEXT NOT NULL DEFAULT 'Tournament',
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN paused_player_ids TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN paused_at TIMESTAMPTZ,
  ADD COLUMN cancelled_at TIMESTAMPTZ;

ALTER TABLE matches
  ADD COLUMN external_id TEXT,
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE matches SET external_id = public_id::text WHERE external_id IS NULL;
ALTER TABLE matches ALTER COLUMN external_id SET NOT NULL;
CREATE UNIQUE INDEX matches_tournament_external_id_unique ON matches (tournament_id, external_id);

ALTER TABLE user_sessions ADD COLUMN idempotency_request_id UUID
  REFERENCES idempotency_requests(id) ON DELETE SET NULL;
CREATE INDEX user_sessions_idempotency_request_idx ON user_sessions (idempotency_request_id)
  WHERE idempotency_request_id IS NOT NULL;

ALTER TABLE match_sides
  ADD COLUMN side_id TEXT,
  ADD COLUMN fixed_team_id UUID,
  ADD COLUMN fixed_team_name_snapshot TEXT,
  ADD CONSTRAINT match_sides_fixed_team_fk
    FOREIGN KEY (fixed_team_id, owner_id) REFERENCES teams(id, owner_id)
    ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX tournaments_owner_status_idx ON tournaments (owner_id, status, created_at DESC);
CREATE INDEX matches_status_idx ON matches (tournament_id, normalized_status, sequence_no);
CREATE INDEX idempotency_owner_operation_created_idx ON idempotency_requests (owner_id, operation, created_at DESC);

-- Owner changes cascade through all normalized composite relationships during
-- a guest claim. Domain rows are moved only after conflicts are resolved in
-- the same transaction. Deferred team-entry triggers validate final states.
