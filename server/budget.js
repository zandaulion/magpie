// What an account is allowed to spend of someone else's money.
//
// Nobody is attacking this yet -- it is one person and some friends. The
// limit is here because the exposure is structural rather than hypothetical:
// a model call costs money and someone else picks when it happens, and that
// is true from the first day whatever the guest list looks like.

import { db, nowIso } from './db.js';

/**
 * Calls to the vision model, per account, per day.
 *
 * Counted per account and not per feature. Generating a topic name, writing an
 * extension and re-writing it all cost roughly the same, so capping one and
 * not the others only decides which door the traffic uses.
 *
 * Embedding a scrap is deliberately outside this. It runs on every save, costs
 * a fraction of a cent, and is what makes connections work at all -- rationing
 * it would ration the thing the app is for.
 *
 * The number is set well above honest use rather than close to it: six meals a
 * day with a couple of corrections is eight calls, so this is roughly six times
 * a heavy day. A limit that a real person can reach by using the app properly
 * is a bug that looks like a policy.
 */
export const DAILY_LIMIT = Number(process.env.MAGPIE_DAILY_AI_LIMIT) || 50;

export class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 429;
  }
}

const today = () => nowIso().slice(0, 10);

/**
 * Claims one call against today's allowance, or refuses.
 *
 * Charged before the model is called, never after. A call that fails still
 * cost money and still has to count, or inducing failures becomes the cheap
 * way to loop. The only calls that go uncharged are the ones this server
 * declines before reaching the model at all, which is why `charge` sits after
 * validation at every call site rather than at the top of the handler.
 *
 * The insert and the check are one statement so two requests arriving together
 * cannot both read the same count and both decide there was room.
 */
export function charge(accountId) {
  const day = today();
  const row = db.prepare(`
    INSERT INTO ai_usage (account_id, day, calls) VALUES (?, ?, 1)
    ON CONFLICT (account_id, day) DO UPDATE SET calls = calls + 1
      WHERE calls < ?
    RETURNING calls
  `).get(accountId, day, DAILY_LIMIT);

  // No row means the guarded update did not fire: the allowance is used up.
  if (!row) {
    throw new BudgetError(
      'daily_limit',
      `Astea sunt ${DAILY_LIMIT} pe ziua de azi, cât ține o zi. O ia de la capăt mâine.`
    );
  }
  return row.calls;
}

/** Hands a call back when the model was never reached. */
export function refund(accountId) {
  db.prepare(
    'UPDATE ai_usage SET calls = MAX(calls - 1, 0) WHERE account_id = ? AND day = ?'
  ).run(accountId, today());
}

export function usedToday(accountId) {
  return db.prepare('SELECT calls FROM ai_usage WHERE account_id = ? AND day = ?')
    .get(accountId, today())?.calls || 0;
}

/**
 * The words of a correction, reduced to what actually changes the answer.
 *
 * Case and spacing do not, so "Not chicken" and "not  chicken" are the same
 * question and deserve the same answer without a second call.
 */
