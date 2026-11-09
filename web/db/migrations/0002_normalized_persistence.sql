-- Expand-only normalized schema. Legacy columns and JSON documents are retained.
SET lock_timeout = '5s';

ALTER TABLE users
  ADD COLUMN username_key TEXT,
  ADD COLUMN username_key_version TEXT,
  ADD COLUMN disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD CONSTRAINT users_username_key_nonempty CHECK (username_key IS NULL OR username_key <> '') NOT VALID;
CREATE UNIQUE INDEX users_username_key_unique ON users (username_key) WHERE username_key IS NOT NULL;

CREATE TABLE user_sessions (
  id UUID PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  csrf_token_hash BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  client_metadata JSONB,
  CHECK (octet_length(token_hash) = 32),
  CHECK (octet_length(csrf_token_hash) = 32),
  CHECK (expires_at > created_at)
);
CREATE INDEX user_sessions_active_by_user ON user_sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE guest_sessions (
  id UUID PRIMARY KEY,
  token_hash BYTEA NOT NULL UNIQUE,
  csrf_token_hash BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  client_metadata JSONB,
  CHECK (octet_length(token_hash) = 32),
  CHECK (octet_length(csrf_token_hash) = 32),
  CHECK (expires_at > created_at)
);
CREATE INDEX guest_sessions_active_by_expiry ON guest_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE data_owners (
  id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  guest_session_id UUID REFERENCES guest_sessions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'quarantined', 'merged')),
  legacy_namespace TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  merged_into_owner_id UUID REFERENCES data_owners(id) ON DELETE RESTRICT,
  CHECK (
    (status = 'quarantined' AND user_id IS NULL AND guest_session_id IS NULL AND legacy_namespace IS NOT NULL)
    OR
    (status IN ('active', 'merged') AND num_nonnulls(user_id, guest_session_id) = 1)
  ),
  CHECK ((status = 'merged') = (merged_into_owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX data_owners_user_unique ON data_owners (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX data_owners_guest_unique ON data_owners (guest_session_id) WHERE guest_session_id IS NOT NULL;
CREATE UNIQUE INDEX data_owners_quarantine_namespace_unique ON data_owners (legacy_namespace)
  WHERE status = 'quarantined';
CREATE INDEX data_owners_merged_into_idx ON data_owners (merged_into_owner_id) WHERE merged_into_owner_id IS NOT NULL;
ALTER TABLE user_sessions ADD COLUMN pending_guest_owner_id UUID REFERENCES data_owners(id) ON DELETE RESTRICT;

ALTER TABLE players
  ADD COLUMN owner_id UUID REFERENCES data_owners(id) ON DELETE RESTRICT,
  ADD COLUMN name_key TEXT,
  ADD COLUMN name_key_version TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN import_batch_id UUID;
ALTER TABLE players ADD CONSTRAINT players_nonnegative_stats CHECK (
  games_played >= 0 AND wins >= 0 AND losses >= 0 AND draws >= 0 AND points_for >= 0 AND points_against >= 0
) NOT VALID;
ALTER TABLE players ADD CONSTRAINT players_name_key_nonempty CHECK (name_key IS NULL OR name_key <> '') NOT VALID;
CREATE UNIQUE INDEX players_id_owner_unique ON players (id, owner_id);
CREATE INDEX players_owner_created_idx ON players (owner_id, created_at DESC);
CREATE UNIQUE INDEX players_owner_name_key_unique ON players (owner_id, name_key)
  WHERE deleted_at IS NULL AND name_key IS NOT NULL;

ALTER TABLE tournaments
  ADD COLUMN public_id UUID,
  ADD COLUMN owner_id UUID REFERENCES data_owners(id) ON DELETE RESTRICT,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN seed TEXT,
  ADD COLUMN generator_version TEXT,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN import_batch_id UUID;
UPDATE tournaments SET public_id = gen_random_uuid() WHERE public_id IS NULL;
ALTER TABLE tournaments ALTER COLUMN public_id SET NOT NULL;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_status_check
  CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')) NOT VALID;
CREATE UNIQUE INDEX tournaments_public_id_unique ON tournaments (public_id);
CREATE UNIQUE INDEX tournaments_id_owner_unique ON tournaments (id, owner_id);
CREATE INDEX tournaments_owner_created_idx ON tournaments (owner_id, created_at DESC);

ALTER TABLE matches
  ADD COLUMN public_id UUID,
  ADD COLUMN owner_id UUID REFERENCES data_owners(id) ON DELETE RESTRICT,
  ADD COLUMN sequence_no INTEGER,
  ADD COLUMN normalized_status TEXT NOT NULL DEFAULT 'scheduled',
  ADD COLUMN winner_side SMALLINT,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN import_batch_id UUID;
UPDATE matches SET public_id = gen_random_uuid() WHERE public_id IS NULL;
UPDATE matches SET sequence_no = id WHERE sequence_no IS NULL;
UPDATE matches m SET owner_id = t.owner_id FROM tournaments t WHERE m.tournament_id = t.id AND m.owner_id IS NULL;
UPDATE matches SET normalized_status = CASE
  WHEN end_time IS NOT NULL THEN 'completed'
  WHEN lower(coalesce(status, '')) IN ('paused', 'in_progress', 'scheduled', 'skipped') THEN lower(status)
  ELSE 'scheduled'
END;
UPDATE matches SET completed_at = end_time WHERE completed_at IS NULL AND end_time IS NOT NULL;
ALTER TABLE matches ALTER COLUMN public_id SET NOT NULL;
ALTER TABLE matches ALTER COLUMN sequence_no SET NOT NULL;
ALTER TABLE matches ADD CONSTRAINT matches_sequence_positive CHECK (sequence_no > 0) NOT VALID;
ALTER TABLE matches ADD CONSTRAINT matches_normalized_status_check
  CHECK (normalized_status IN ('scheduled', 'in_progress', 'paused', 'completed', 'skipped')) NOT VALID;
ALTER TABLE matches ADD CONSTRAINT matches_winner_side_check CHECK (winner_side IN (1, 2) OR winner_side IS NULL) NOT VALID;
CREATE UNIQUE INDEX matches_public_id_unique ON matches (public_id);
CREATE UNIQUE INDEX matches_tournament_sequence_unique ON matches (tournament_id, sequence_no);
CREATE UNIQUE INDEX matches_id_tournament_owner_unique ON matches (id, tournament_id, owner_id);
CREATE UNIQUE INDEX matches_tournament_idempotency_unique ON matches (tournament_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX matches_owner_tournament_sequence_idx ON matches (owner_id, tournament_id, sequence_no);
ALTER TABLE matches ADD CONSTRAINT matches_owner_matches_tournament_fk
  FOREIGN KEY (tournament_id, owner_id) REFERENCES tournaments(id, owner_id)
  ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID;

CREATE TABLE teams (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES data_owners(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL CHECK (name_key <> ''),
  name_key_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at TIMESTAMPTZ,
  UNIQUE (id, owner_id)
);
CREATE UNIQUE INDEX teams_owner_name_key_unique ON teams (owner_id, name_key) WHERE deleted_at IS NULL;
CREATE INDEX teams_owner_created_idx ON teams (owner_id, created_at DESC);

CREATE TABLE team_members (
  team_id UUID NOT NULL,
  owner_id UUID NOT NULL,
  player_id INTEGER NOT NULL,
  position SMALLINT NOT NULL CHECK (position IN (1, 2)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, player_id),
  UNIQUE (team_id, position),
  FOREIGN KEY (team_id, owner_id) REFERENCES teams(id, owner_id)
    ON DELETE CASCADE ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (player_id, owner_id) REFERENCES players(id, owner_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX team_members_player_idx ON team_members (player_id);

CREATE FUNCTION assert_team_has_two_members() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_team UUID;
  member_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'teams' THEN
    IF TG_OP = 'DELETE' THEN target_team := OLD.id; ELSE target_team := NEW.id; END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RAISE EXCEPTION 'team membership must move through delete and insert';
    END IF;
    IF TG_OP = 'DELETE' THEN target_team := OLD.team_id; ELSE target_team := NEW.team_id; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM teams WHERE id = target_team) THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO member_count FROM team_members WHERE team_id = target_team;
  IF member_count <> 2 THEN
    RAISE EXCEPTION 'a reusable team must contain exactly two members';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER teams_require_two_members
  AFTER INSERT OR UPDATE ON teams DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_team_has_two_members();
CREATE CONSTRAINT TRIGGER team_members_require_two_members
  AFTER INSERT OR UPDATE OR DELETE ON team_members DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_team_has_two_members();

CREATE TABLE tournament_enrollments (
  id UUID PRIMARY KEY,
  tournament_id INTEGER NOT NULL,
  owner_id UUID NOT NULL,
  player_id INTEGER,
  player_name_snapshot TEXT NOT NULL,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ,
  seed INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (id, tournament_id, owner_id),
  UNIQUE (id, tournament_id, owner_id, player_id),
  FOREIGN KEY (tournament_id, owner_id) REFERENCES tournaments(id, owner_id)
    ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (player_id, owner_id) REFERENCES players(id, owner_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX tournament_enrollments_player_unique ON tournament_enrollments (tournament_id, player_id)
  WHERE player_id IS NOT NULL;
CREATE INDEX tournament_enrollments_player_owner_idx ON tournament_enrollments (player_id, owner_id) WHERE player_id IS NOT NULL;
CREATE INDEX tournament_enrollments_owner_time_idx ON tournament_enrollments (owner_id, enrolled_at);

CREATE TABLE tournament_schedule_events (
  id UUID PRIMARY KEY,
  tournament_id INTEGER NOT NULL,
  owner_id UUID NOT NULL,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('bye', 'rest')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('player', 'fixed_team')),
  subject_id TEXT NOT NULL,
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  enrollment_id UUID,
  player_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, sequence_no, event_type, subject_type, subject_id),
  FOREIGN KEY (tournament_id, owner_id) REFERENCES tournaments(id, owner_id)
    ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (enrollment_id, tournament_id, owner_id) REFERENCES tournament_enrollments(id, tournament_id, owner_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX tournament_schedule_events_owner_idx ON tournament_schedule_events (owner_id, tournament_id, sequence_no);

CREATE TABLE fixed_team_entries (
  id UUID PRIMARY KEY,
  tournament_id INTEGER NOT NULL,
  owner_id UUID NOT NULL,
  entry_number INTEGER NOT NULL CHECK (entry_number > 0),
  team_id UUID,
  team_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tournament_id, owner_id),
  UNIQUE (tournament_id, entry_number),
  FOREIGN KEY (tournament_id, owner_id) REFERENCES tournaments(id, owner_id)
    ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (team_id, owner_id) REFERENCES teams(id, owner_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX fixed_team_entries_team_unique ON fixed_team_entries (tournament_id, team_id) WHERE team_id IS NOT NULL;
CREATE INDEX fixed_team_entries_team_owner_idx ON fixed_team_entries (team_id, owner_id) WHERE team_id IS NOT NULL;

CREATE TABLE fixed_team_entry_members (
  fixed_team_entry_id UUID NOT NULL,
  tournament_id INTEGER NOT NULL,
  owner_id UUID NOT NULL,
  position SMALLINT NOT NULL CHECK (position IN (1, 2)),
  player_id INTEGER,
  player_name_snapshot TEXT NOT NULL,
  enrollment_id UUID,
  PRIMARY KEY (fixed_team_entry_id, position),
  UNIQUE (fixed_team_entry_id, player_id),
  FOREIGN KEY (fixed_team_entry_id, tournament_id, owner_id)
    REFERENCES fixed_team_entries(id, tournament_id, owner_id)
    ON DELETE CASCADE ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (player_id, owner_id) REFERENCES players(id, owner_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (enrollment_id, tournament_id, owner_id)
    REFERENCES tournament_enrollments(id, tournament_id, owner_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (enrollment_id, tournament_id, owner_id, player_id)
    REFERENCES tournament_enrollments(id, tournament_id, owner_id, player_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX fixed_team_entry_player_once ON fixed_team_entry_members (tournament_id, player_id) WHERE player_id IS NOT NULL;

CREATE FUNCTION assert_fixed_entry_has_two_members() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_entry UUID;
  member_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'fixed_team_entries' THEN
    IF TG_OP = 'DELETE' THEN target_entry := OLD.id; ELSE target_entry := NEW.id; END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.fixed_team_entry_id IS DISTINCT FROM OLD.fixed_team_entry_id THEN
      RAISE EXCEPTION 'fixed team membership must move through delete and insert';
    END IF;
    IF TG_OP = 'DELETE' THEN target_entry := OLD.fixed_team_entry_id; ELSE target_entry := NEW.fixed_team_entry_id; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fixed_team_entries WHERE id = target_entry) THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO member_count FROM fixed_team_entry_members WHERE fixed_team_entry_id = target_entry;
  IF member_count <> 2 THEN
    RAISE EXCEPTION 'a fixed team entry must contain exactly two members';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER fixed_team_entries_require_two_members
  AFTER INSERT OR UPDATE ON fixed_team_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_fixed_entry_has_two_members();
CREATE CONSTRAINT TRIGGER fixed_team_members_require_two_members
  AFTER INSERT OR UPDATE OR DELETE ON fixed_team_entry_members DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_fixed_entry_has_two_members();

CREATE TABLE match_sides (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
  owner_id UUID NOT NULL REFERENCES data_owners(id) ON DELETE RESTRICT,
  side_no SMALLINT NOT NULL CHECK (side_no IN (1, 2)),
  score INTEGER CHECK (score IS NULL OR score >= 0),
  side_label TEXT,
  PRIMARY KEY (match_id, side_no),
  UNIQUE (match_id, side_no, tournament_id, owner_id),
  FOREIGN KEY (match_id, tournament_id, owner_id) REFERENCES matches(id, tournament_id, owner_id)
    ON DELETE CASCADE ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX match_sides_tournament_idx ON match_sides (tournament_id, match_id);
CREATE INDEX match_sides_owner_idx ON match_sides (owner_id, tournament_id);

CREATE TABLE match_players (
  match_id INTEGER NOT NULL,
  side_no SMALLINT NOT NULL,
  tournament_id INTEGER NOT NULL,
  owner_id UUID NOT NULL REFERENCES data_owners(id) ON DELETE RESTRICT,
  position SMALLINT NOT NULL CHECK (position IN (1, 2)),
  player_id INTEGER,
  enrollment_id UUID,
  player_name_snapshot TEXT NOT NULL,
  PRIMARY KEY (match_id, side_no, position),
  UNIQUE (match_id, player_id),
  FOREIGN KEY (match_id, side_no, tournament_id, owner_id) REFERENCES match_sides(match_id, side_no, tournament_id, owner_id)
    ON DELETE CASCADE ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (player_id, owner_id) REFERENCES players(id, owner_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (enrollment_id, tournament_id, owner_id) REFERENCES tournament_enrollments(id, tournament_id, owner_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (enrollment_id, tournament_id, owner_id, player_id)
    REFERENCES tournament_enrollments(id, tournament_id, owner_id, player_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX match_players_tournament_idx ON match_players (tournament_id, match_id, side_no, position);
CREATE INDEX match_players_player_idx ON match_players (player_id);
CREATE INDEX match_players_owner_idx ON match_players (owner_id, tournament_id);

CREATE TABLE match_pause_intervals (
  id UUID PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  reason TEXT,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX match_pause_one_open_interval ON match_pause_intervals (match_id) WHERE ended_at IS NULL;

CREATE TABLE idempotency_requests (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES data_owners(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash BYTEA NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response JSONB,
  result_entity_type TEXT,
  result_entity_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (owner_id, operation, key),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (octet_length(request_hash) = 32)
);
CREATE INDEX idempotency_created_idx ON idempotency_requests (created_at);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'guest', 'system', 'legacy')),
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  guest_session_id UUID REFERENCES guest_sessions(id) ON DELETE RESTRICT,
  owner_id UUID REFERENCES data_owners(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  request_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (actor_type <> 'user' OR user_id IS NOT NULL),
  CHECK (actor_type <> 'guest' OR guest_session_id IS NOT NULL)
);
CREATE INDEX audit_owner_time_idx ON audit_events (owner_id, occurred_at DESC);
CREATE INDEX audit_entity_idx ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_user_idx ON audit_events (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX audit_guest_session_idx ON audit_events (guest_session_id) WHERE guest_session_id IS NOT NULL;

CREATE FUNCTION reject_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE TABLE import_batches (
  id UUID PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('legacy_postgres', 'local_json')),
  source_identifier TEXT NOT NULL,
  content_hash BYTEA NOT NULL,
  importer_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'needs_review')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_summary TEXT
);
CREATE INDEX import_batches_source_idx ON import_batches (source_type, source_identifier, started_at DESC);

CREATE TABLE import_records (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  source_namespace TEXT NOT NULL,
  source_entity TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_hash BYTEA NOT NULL,
  target_entity TEXT,
  target_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('imported', 'quarantined', 'needs_review', 'skipped')),
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (batch_id, source_namespace, source_entity, source_key)
);
CREATE INDEX import_records_source_lookup_idx ON import_records (source_namespace, source_entity, source_key);

CREATE FUNCTION reject_snapshot_name_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.player_name_snapshot IS DISTINCT FROM OLD.player_name_snapshot THEN
    RAISE EXCEPTION 'historical participant snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tournament_enrollment_snapshot_immutable BEFORE UPDATE ON tournament_enrollments
  FOR EACH ROW EXECUTE FUNCTION reject_snapshot_name_change();
CREATE TRIGGER fixed_team_member_snapshot_immutable BEFORE UPDATE ON fixed_team_entry_members
  FOR EACH ROW EXECUTE FUNCTION reject_snapshot_name_change();
CREATE TRIGGER match_player_snapshot_immutable BEFORE UPDATE ON match_players
  FOR EACH ROW EXECUTE FUNCTION reject_snapshot_name_change();

ALTER TABLE players ADD CONSTRAINT players_import_batch_fk FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_import_batch_fk FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT;
ALTER TABLE matches ADD CONSTRAINT matches_import_batch_fk FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT;

-- Historical guest cookie strings are deliberately not referenced as active
-- guest sessions. Ownership backfill is performed by the explicit importer.
