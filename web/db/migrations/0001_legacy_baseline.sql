-- Fresh-install compatibility schema. Existing installations are baselined by
-- the migration runner and do not execute this file, preserving their data.
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE players (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  guest_session_id VARCHAR(255),
  name VARCHAR(255) NOT NULL,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  points_for INTEGER NOT NULL DEFAULT 0,
  points_against INTEGER NOT NULL DEFAULT 0,
  diff INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tournaments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  guest_session_id VARCHAR(255),
  mode VARCHAR(255),
  date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  standings JSONB
);

CREATE TABLE matches (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  guest_session_id VARCHAR(255),
  teams JSONB NOT NULL,
  status VARCHAR(50),
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  mode VARCHAR(255),
  round INTEGER,
  court INTEGER
);
