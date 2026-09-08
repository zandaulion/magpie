/**
 * Magpie — throwing a lot of it away at once.
 *
 * Deleting one scrap is already the person's own act. This is the same act in
 * bulk, and the only thing that really changes is that a mistake costs more --
 * so everything here is built so the caller can say exactly what is about to
 * go before anything goes.
 *
 * Windows are local calendar days, not rolling hours. "What I put in today"
 * is the question being asked, and a 24-hour window would answer a different
 * one by quietly taking half of yesterday evening with it. The timezone
 * arrives from the client the same way it does for the statistics, as minutes
 * east of UTC.
 */

import { db } from './db.js';

/** The scopes a purge can have, narrowest first. */
export const SCOPES = ['day', 'week', 'all'];

/**
 * Minutes east of UTC as a SQLite modifier.
 *
 * Clamped to the real range of world offsets, as /api/stats does: the value
 * comes from the client and decides which rows a delete touches, so it is not
 * somewhere to accept an arbitrary number.
 */
export function shiftOf(tz) {
  const mins = Math.max(-840, Math.min(840, Math.trunc(Number(tz)) || 0));
  return `${mins >= 0 ? '+' : '-'}${Math.abs(mins)} minutes`;
}

/**
 * The WHERE clause for a scope, and its parameters.
 *
 * `all` is deliberately not "since the beginning of time": a scrap saved by a
 * device whose clock was wrong could sit outside any window, and the button
 * that says everything has to mean everything.
 */
function scopeClause(scope, shift) {
  if (scope === 'all') return { sql: '', args: [] };

  // Counting back from today inclusive: a week is today and the six before
  // it, a day is today alone.
  const back = scope === 'week' ? '-6 days' : '-0 days';
  return {
    sql: ` AND date(datetime(created_at, ?)) >= date(datetime('now', ?), ?)`,
    args: [shift, shift, back]
  };
}

/** How many scraps each button would take, for labelling them. */
export function purgeableCounts(accountId, tz) {
  const shift = shiftOf(tz);
  const counts = {};

  for (const scope of SCOPES) {
    const { sql, args } = scopeClause(scope, shift);
    counts[scope] = db.prepare(
      `SELECT COUNT(*) AS n FROM scraps WHERE account_id = ?${sql}`
    ).get(accountId, ...args).n;
  }

  return counts;
}

/**
 * Delete a window of scraps, and say what it cost.
 *
 * Rows go first and files afterwards, which is the order that fails safely.
 * The other way round, a transaction that rolls back would leave rows pointing
 * at pictures that no longer exist -- a scrap that renders as a broken image
 * for ever. This way a failed unlink leaves a file nothing references, which
 * is invisible and can be swept up later.
 *
 * `all` takes the topics with it. Everything else leaves them alone: a topic
 * that loses its scraps drops out of listTopics by itself, and anything
 * written about it survives. But when someone asks for a clean slate, leaving
 * five topics behind that display nothing is not a clean slate.
 */
export function purgeScraps(accountId, { scope, tz }) {
  if (!SCOPES.includes(scope)) return null;

  const shift = shiftOf(tz);
  const { sql, args } = scopeClause(scope, shift);

  // Read the filenames before the rows are gone; there is no second chance to
  // learn what a deleted row was pointing at.
  const doomed = db.prepare(
    `SELECT id, image_id, audio_id FROM scraps WHERE account_id = ?${sql}`
  ).all(accountId, ...args);

  const topicsBefore = liveTopicIds(accountId);

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM scraps WHERE account_id = ?${sql}`).run(accountId, ...args);
    if (scope === 'all') {
      // Extensions hang off topics and go with them.
      db.prepare('DELETE FROM topics WHERE account_id = ?').run(accountId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const topicsAfter = scope === 'all' ? new Set() : liveTopicIds(accountId);
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM scraps WHERE account_id = ?')
    .get(accountId).n;

  return {
    deleted: doomed.length,
    remaining,
    // Named so the caller can say "two topics have nothing left in them"
    // rather than letting them vanish from the list without explanation.
    topicsEmptied: [...topicsBefore].filter((id) => !topicsAfter.has(id)).length,
    images: doomed.map((d) => d.image_id).filter(Boolean),
    audio: doomed.map((d) => d.audio_id).filter(Boolean)
  };
}

/** Topics that still have at least one scrap in them -- what listTopics shows. */
function liveTopicIds(accountId) {
  return new Set(db.prepare(`
    SELECT t.id FROM topics t
    WHERE t.account_id = ?
      AND EXISTS (SELECT 1 FROM scrap_topics st WHERE st.topic_id = t.id)
  `).all(accountId).map((t) => t.id));
}
