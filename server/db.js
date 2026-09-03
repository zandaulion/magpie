// The store. One SQLite file, no ORM, no migrations yet -- this is a new
// database and everything below is the first shape it has ever had.
//
// The account, device and invite tables are lifted from Plate unchanged. They
// are the shape the invite console expects, and being identical is the point:
// the same console drives every app.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** Photographs attached to scraps. Outside the database, like Plate's. */
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMAGE_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'magpie.db'));
export const nowIso = () => new Date().toISOString();

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  -- A person. Holds no name, email or password: identity is the random id and
  -- a recovery code they keep. Nothing here identifies anyone off this server.
  CREATE TABLE IF NOT EXISTS accounts (
    id              TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    recovery_hash   TEXT,
    recovery_set_at TEXT
  );

  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    label       TEXT,
    created_at  TEXT NOT NULL,
    last_seen   TEXT,
    revoked     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash   TEXT NOT NULL UNIQUE,
    code        TEXT,
    label       TEXT,
    url         TEXT,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    -- Cancelled, not deleted, so the console can show that an invite was
    -- withdrawn rather than leaving a gap that looks like one never sent.
    revoked     INTEGER NOT NULL DEFAULT 0,
    device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL
  );

  -- Short-lived codes that add a second device to an existing account. Minted
  -- only from a device already signed in, so possession of a working device is
  -- the authority for adding another.
  CREATE TABLE IF NOT EXISTS device_links (
    code_hash   TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
  );
`);

db.exec(`
  -- A scrap: one thing thrown in, exactly as it was thrown.
  --
  -- Immutable by design. The whole promise is that your words stay yours, so
  -- there is no UPDATE path for body -- corrections and second thoughts are
  -- new scraps, and anything Magpie makes of them lives in its own table.
  -- Deletion is the only destructive act, and it is the person's own.
  CREATE TABLE IF NOT EXISTS scraps (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL,
    body        TEXT NOT NULL DEFAULT '',
    image_id    TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scraps_account ON scraps(account_id, created_at DESC);

  -- The vector for one scrap, as raw float32 bytes.
  --
  -- Kept beside the scrap rather than inside it because it is derived: it can
  -- be thrown away and recomputed, and a scrap with no embedding yet is still
  -- a perfectly good scrap. Similarity is computed in process -- a few
  -- thousand vectors is nothing, and it means connections cost no model call.
  CREATE TABLE IF NOT EXISTS embeddings (
    scrap_id    TEXT PRIMARY KEY REFERENCES scraps(id) ON DELETE CASCADE,
    model       TEXT NOT NULL,
    dims        INTEGER NOT NULL,
    vector      BLOB NOT NULL,
    created_at  TEXT NOT NULL
  );

  -- A topic is a durable object, not whatever the clustering produced today.
  --
  -- This matters: if a topic were only ever a recomputed cluster, the name a
  -- person gave it would have nothing to attach to and would dissolve on the
  -- next run. So clustering proposes, and what it proposes becomes a row with
  -- an id that outlives it.
  CREATE TABLE IF NOT EXISTS topics (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- Set when the person names it themselves. Their name is never replaced by
    -- a later suggestion.
    named_by_user INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_topics_account ON topics(account_id, updated_at DESC);

  -- Scraps belong to topics, plural. A half-formed idea genuinely sits under
  -- several things at once, and forcing one home is how the filing goes wrong
  -- and the thing becomes unfindable.
  CREATE TABLE IF NOT EXISTS scrap_topics (
    scrap_id    TEXT NOT NULL REFERENCES scraps(id) ON DELETE CASCADE,
    topic_id    TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    -- How well it fits, kept so a weak assignment can be shown as tentative
    -- rather than stated as fact.
    score       REAL,
    added_at    TEXT NOT NULL,
    PRIMARY KEY (scrap_id, topic_id)
  );
  CREATE INDEX IF NOT EXISTS idx_scrap_topics_topic ON scrap_topics(topic_id);

  -- What Magpie made of a topic.
  --
  -- Its own table, never mixed into a scrap. If the model's prose and the
  -- person's own were stored the same way, in six months nobody could tell
  -- which thoughts were theirs -- which for an ideas tool is corrosive.
  --
  -- Editing one makes it the person's: "mine" flips, and a later regeneration
  -- adds a new row beside it instead of overwriting words they touched.
  CREATE TABLE IF NOT EXISTS extensions (
    id          TEXT PRIMARY KEY,
    topic_id    TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    mine        INTEGER NOT NULL DEFAULT 0,
    model       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_extensions_topic ON extensions(topic_id, created_at DESC);
`);

db.exec(`
  -- Calls to the model, per account per day. Same shape as Plate's, because
  -- the exposure is the same: a cost per call whose timing someone else picks.
  CREATE TABLE IF NOT EXISTS ai_usage (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,
    calls      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, day)
  );
`);
