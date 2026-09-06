/**
 * Magpie — what it made of a topic, and what you made of that.
 *
 * Two rules govern everything here, and both come from the same worry: in six
 * months a person must be able to tell which thoughts were theirs.
 *
 * The first is that the model's prose is never stored as if it were the
 * person's. It lives in its own table, marked with the model that wrote it.
 *
 * The second is that editing one makes it yours. `mine` flips, and a later
 * regeneration adds a new row beside it rather than overwriting words you
 * touched -- because the moment a regeneration can silently replace something
 * you rewrote, nothing here is safe to rewrite.
 */

import crypto from 'node:crypto';
import { db, nowIso } from './db.js';

const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

/** Everything written about a topic, newest first. */
export function listExtensions(accountId, topicId) {
  const owned = db.prepare('SELECT id FROM topics WHERE id = ? AND account_id = ?')
    .get(topicId, accountId);
  if (!owned) return null;

  return db.prepare(`
    SELECT id, body, mine, model, created_at, updated_at
    FROM extensions WHERE topic_id = ?
    ORDER BY created_at DESC
  `).all(topicId).map((e) => ({
    id: e.id,
    body: e.body,
    mine: Boolean(e.mine),
    model: e.model,
    createdAt: e.created_at,
    updatedAt: e.updated_at
  }));
}

/**
 * Keep a new reading.
 *
 * Always an insert, never an update. A regeneration is a second opinion, not a
 * correction of the first -- and if the first has been edited it is somebody's
 * own writing, which nothing here is allowed to overwrite.
 */
export function addExtension(accountId, topicId, body, model) {
  const owned = db.prepare('SELECT id FROM topics WHERE id = ? AND account_id = ?')
    .get(topicId, accountId);
  if (!owned) return null;

  const text = String(body || '').trim();
  if (!text) return null;

  const id = newId('ext');
  const now = nowIso();
  db.prepare(`
    INSERT INTO extensions (id, topic_id, body, mine, model, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `).run(id, topicId, text, model || null, now, now);

  return { id, body: text, mine: false, model: model || null, createdAt: now, updatedAt: now };
}

/**
 * Your words now.
 *
 * `mine` is set on the first edit and never cleared: once a person has been in
 * here, the row stops being the model's however much of it survives. The model
 * name is kept rather than wiped, so where it started is still knowable.
 */
export function editExtension(accountId, extensionId, body) {
  const row = db.prepare(`
    SELECT e.id FROM extensions e
    JOIN topics t ON t.id = e.topic_id
    WHERE e.id = ? AND t.account_id = ?
  `).get(extensionId, accountId);
  if (!row) return null;

  const text = String(body || '').trim();
  if (!text) return null;

  const now = nowIso();
  db.prepare('UPDATE extensions SET body = ?, mine = 1, updated_at = ? WHERE id = ?')
    .run(text, now, extensionId);

  return { id: extensionId, body: text, mine: true, updatedAt: now };
}

/**
 * Throw one away.
 *
 * Allowed on anything, including something edited: a person may delete their
 * own writing. Nothing else here removes a row, which is why this is the only
 * place the distinction does not apply.
 */
export function deleteExtension(accountId, extensionId) {
  const done = db.prepare(`
    DELETE FROM extensions WHERE id = ? AND topic_id IN (
      SELECT id FROM topics WHERE account_id = ?
    )
  `).run(extensionId, accountId);
  return done.changes > 0;
}
