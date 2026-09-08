/**
 * Magpie — the scraps that turned out to be things to do.
 *
 * Deliberately not a to-do app. There is no priority, no list, no project and
 * no repeat: the whole feature is "this one is still open", plus a date when
 * there is one. Magpie's job here is to stop losing the things that were
 * quietly tasks, not to become the place you manage them.
 *
 * That restraint is also why nothing in here proposes anything. The echo
 * prompt is under standing orders never to ask what the next step is, and a
 * pile that started marking your own writing as homework would be a different
 * app wearing this one's clothes. Marking is the person's; Magpie only holds
 * the mark.
 *
 * Dates are local calendar days as the client computed them, stored as text.
 * Whether one is overdue is decided by the client too -- it is the only party
 * that knows what day it is where the person is standing, and a server that
 * guessed would be wrong for a few hours every night.
 */

import { db, nowIso } from './db.js';

/** A date the client sent, or null. Anything else is treated as absent. */
export function cleanDue(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Rejects 2026-02-31 and friends, which pass the pattern and then sort into
  // a day that never happens.
  const parsed = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s) return null;
  return s;
}

const ownScrap = (accountId, scrapId) =>
  db.prepare('SELECT id FROM scraps WHERE id = ? AND account_id = ?').get(scrapId, accountId);

/**
 * Make a scrap a task, or change the date on one that already is.
 *
 * Upsert rather than insert, so a second tap sets a date instead of failing,
 * and so re-marking something never disturbs `created_at` or quietly reopens
 * something already ticked off.
 */
export function markTask(accountId, scrapId, dueOn) {
  if (!ownScrap(accountId, scrapId)) return null;

  const due = cleanDue(dueOn);
  db.prepare(`
    INSERT INTO tasks (scrap_id, due_on, done_at, created_at)
    VALUES (?, ?, NULL, ?)
    ON CONFLICT(scrap_id) DO UPDATE SET due_on = excluded.due_on
  `).run(scrapId, due, nowIso());

  return taskOf(scrapId);
}

/**
 * Tick it off, or put it back.
 *
 * Done is a timestamp rather than a flag because when something was finished
 * is worth more than that it was, and costs the same to store.
 */
export function setDone(accountId, scrapId, done) {
  if (!ownScrap(accountId, scrapId)) return null;
  const existing = taskOf(scrapId);
  if (!existing) return null;

  db.prepare('UPDATE tasks SET done_at = ? WHERE scrap_id = ?')
    .run(done ? nowIso() : null, scrapId);
  return taskOf(scrapId);
}

/**
 * It was not a task after all.
 *
 * Removes the mark and leaves the scrap exactly as it was written. This is the
 * only destructive path here, and it destroys nothing the person wrote.
 */
export function unmarkTask(accountId, scrapId) {
  if (!ownScrap(accountId, scrapId)) return false;
  return db.prepare('DELETE FROM tasks WHERE scrap_id = ?').run(scrapId).changes > 0;
}

export function taskOf(scrapId) {
  const row = db.prepare('SELECT scrap_id, due_on, done_at, created_at FROM tasks WHERE scrap_id = ?')
    .get(scrapId);
  return row ? shape(row) : null;
}

/** Every task on the account, with the scrap it was made from. */
export function listTasks(accountId) {
  const rows = db.prepare(`
    SELECT t.scrap_id, t.due_on, t.done_at, t.created_at,
           s.body, s.image_id, s.audio_id, s.created_at AS scrap_created_at
    FROM tasks t JOIN scraps s ON s.id = t.scrap_id
    WHERE s.account_id = ?
  `).all(accountId).map((r) => ({
    ...shape(r),
    body: r.body,
    hasImage: Boolean(r.image_id),
    hasAudio: Boolean(r.audio_id),
    scrapCreatedAt: r.scrap_created_at
  }));

  const open = rows.filter((t) => !t.doneAt).sort(byDueThenAge);
  // Newest first: the useful thing about a finished task is that it was the
  // one just ticked off, in case that was a mistake.
  const done = rows.filter((t) => t.doneAt).sort((a, b) => (a.doneAt < b.doneAt ? 1 : -1));

  return { open, done };
}

/**
 * Dated first, soonest at the top; undated below, oldest first.
 *
 * Undated tasks are not less important, they are less scheduled -- but the
 * oldest of them is the one most likely to have been forgotten, which is the
 * only thing this list is for.
 */
function byDueThenAge(a, b) {
  if (a.dueOn && b.dueOn) return a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0;
  if (a.dueOn) return -1;
  if (b.dueOn) return 1;
  return a.scrapCreatedAt < b.scrapCreatedAt ? -1 : 1;
}

/** How many are still open, for the badge on the way in. */
export function openTaskCount(accountId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM tasks t JOIN scraps s ON s.id = t.scrap_id
    WHERE s.account_id = ? AND t.done_at IS NULL
  `).get(accountId).n;
}

function shape(row) {
  return {
    scrapId: row.scrap_id,
    dueOn: row.due_on,
    doneAt: row.done_at,
    createdAt: row.created_at
  };
}
