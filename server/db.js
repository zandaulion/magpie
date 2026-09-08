// The store. One SQLite file, no ORM.
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

/**
 * Recordings. Kept, not discarded after transcription.
 *
 * The recording is what the person actually produced, so it is the scrap; the
 * transcript is a reading of it and can be wrong. Throwing the audio away once
 * text existed would make a bad transcript into a lost thought.
 */
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

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
    -- A recording, where there is one. The scrap's body then holds the
    -- transcript, which is Magpie's reading rather than the thing itself --
    -- so the audio stays and can be played back against it.
    audio_id    TEXT,
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
  -- What Magpie said back when a scrap was thrown in.
  --
  -- Its own table for the same reason extensions are: the model's words and
  -- the person's are never stored together. This one is disposable -- it can
  -- be deleted, and losing it loses nothing.
  CREATE TABLE IF NOT EXISTS echoes (
    scrap_id    TEXT PRIMARY KEY REFERENCES scraps(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    model       TEXT,
    created_at  TEXT NOT NULL
  );

  -- A pair of scraps knocked together, and what fell out. Kept so a good one
  -- can be found again, and so the same pair is not served twice running.
  CREATE TABLE IF NOT EXISTS collisions (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    a_id        TEXT NOT NULL REFERENCES scraps(id) ON DELETE CASCADE,
    b_id        TEXT NOT NULL REFERENCES scraps(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    model       TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_collisions_account ON collisions(account_id, created_at DESC);
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

/**
 * Columns added after the database already existed.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that is already there, so
 * a new column has to be added explicitly. This file used to say there were no
 * migrations because the database was new; it stopped being new the moment
 * somebody put a thought in it.
 */
function addColumnIfMissing(table, column, decl) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (have) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  console.log(`migrated ${table}: added ${column}`);
  return true;
}

db.exec(`
  -- A scrap that turned out to be something to do.
  --
  -- Beside the scrap rather than inside it, like everything else derived from
  -- one. Two reasons, and the first is the schema's: the body is immutable, so
  -- becoming a task cannot be a column on it. The second is the app's: capture
  -- must not ask what a thing is. "Baterie externă pentru Luca" is four words
  -- with no verb in it, and a composer that first wanted to know whether that
  -- was a note or a task is a composer people stop typing into.
  --
  -- So nothing here is set when a scrap is saved. A task is something a scrap
  -- becomes afterwards, by hand, and the row simply does not exist until then.
  CREATE TABLE IF NOT EXISTS tasks (
    scrap_id    TEXT PRIMARY KEY REFERENCES scraps(id) ON DELETE CASCADE,
    -- A local calendar date, or null for "sometime". Not a timestamp: nothing
    -- here fires at a moment, and an hour-precise field would promise a
    -- punctuality the app cannot deliver.
    due_on      TEXT,
    -- Null while it is still open. Set rather than deleted, so ticking
    -- something off is undoable and the record of having done it survives.
    done_at     TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(done_at, due_on);
`);

// A recording, where there is one. The body then holds the transcript, which
// is a reading of the audio rather than the thing itself.
addColumnIfMissing('scraps', 'audio_id', 'TEXT');

// Whether Magpie says something back of its own accord. Off does not mean
// never: the remark is then asked for one card at a time. Kept on the account
// rather than in the browser so a preference set on the phone is the same
// preference on the laptop -- it is a decision about the app, not about a
// device.
addColumnIfMissing('accounts', 'auto_echo', 'INTEGER NOT NULL DEFAULT 1');
