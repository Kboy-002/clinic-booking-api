'use strict';

// SQLite storage layer. One file on disk; WAL mode; synchronous driver so
// request handlers can run their checks and writes atomically in one process.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'clinic.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS slots (
    id        TEXT PRIMARY KEY,
    provider  TEXT NOT NULL,
    start_raw TEXT NOT NULL,
    end_raw   TEXT NOT NULL,
    start_ms  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id         TEXT PRIMARY KEY,
    slot_id    TEXT NOT NULL REFERENCES slots(id),
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
    created_at TEXT NOT NULL
  );

  -- Level 3: a slot can hold at most one confirmed booking, enforced by the
  -- database itself so simultaneous requests cannot both win.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_confirmed_slot
    ON bookings (slot_id) WHERE status = 'confirmed';

  CREATE INDEX IF NOT EXISTS idx_bookings_email_created
    ON bookings (email, created_at, id);

  -- Level 4: recorded responses for Idempotency-Key values.
  CREATE TABLE IF NOT EXISTS idempotency (
    key            TEXT PRIMARY KEY,
    request_hash   TEXT NOT NULL,
    status_code    INTEGER,
    response_body  TEXT,
    created_at     TEXT NOT NULL
  );

  -- Level 5: sliding-window attempt log per email.
  CREATE TABLE IF NOT EXISTS rate_attempts (
    email         TEXT NOT NULL,
    attempted_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rate_email_time
    ON rate_attempts (email, attempted_at);
`);

module.exports = db;
