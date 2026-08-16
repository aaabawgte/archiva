PRAGMA foreign_keys = ON;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('auth_epoch', '1');

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  thumb_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  taken_at TEXT,
  description TEXT NOT NULL DEFAULT '',
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  is_private INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
  original_uploaded INTEGER NOT NULL DEFAULT 0 CHECK (original_uploaded IN (0, 1)),
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE photo_people (
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, person_id)
);

CREATE TABLE login_attempts (
  fingerprint TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started INTEGER NOT NULL
);

CREATE INDEX photos_location_idx ON photos(location_id, ready, created_at DESC);
CREATE INDEX photos_taken_at_idx ON photos(taken_at DESC, created_at DESC);
CREATE INDEX photo_people_person_idx ON photo_people(person_id, photo_id);
