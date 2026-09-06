/**
 * Magpie — storing vectors, and finding what is near what.
 *
 * The whole point of embedding on save is that everything afterwards is free.
 * Connections, and later clustering, run here against stored vectors with no
 * model call: the cost was paid once, when the scrap was thrown in.
 *
 * Vectors are stored as raw float32 rather than JSON. A 3072-dimension
 * embedding is about 12 KB packed and roughly 60 KB as text, and the whole
 * pile is read into memory on every connections query -- so the difference is
 * the difference between reading a megabyte and reading five.
 */

import { db, nowIso } from './db.js';
import { embed, embedModel } from './gemini.js';

/** Float32 the way SQLite wants it, and back. */
export function pack(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

export function unpack(buffer, dims) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, dims);
}

/**
 * Embed one scrap and keep the result.
 *
 * Returns false rather than throwing when there is nothing to embed or the
 * model is unreachable: a scrap must be saved even when the vector cannot be,
 * or a model outage would start rejecting the user's own writing. What is
 * missed here is picked up by backfillEmbeddings.
 */
export async function rememberScrap(scrapId, body) {
  const text = String(body || '').trim();
  if (!text) return false;

  try {
    const values = await embed(text);
    db.prepare(`
      INSERT INTO embeddings (scrap_id, model, dims, vector, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scrap_id) DO UPDATE SET
        model = excluded.model, dims = excluded.dims,
        vector = excluded.vector, created_at = excluded.created_at
    `).run(scrapId, embedModel(), values.length, pack(values), nowIso());
    return true;
  } catch (err) {
    console.warn(`[magpie] could not embed ${scrapId}:`, err.message);
    return false;
  }
}

/**
 * Embed everything that has text and no vector yet.
 *
 * Sequential on purpose. This runs over a whole account's history, and firing
 * forty requests at once is how a rate limit turns a backfill into a partial
 * one that looks finished.
 */
export async function backfillEmbeddings(accountId, { limit = 500 } = {}) {
  const pending = db.prepare(`
    SELECT s.id, s.body FROM scraps s
    LEFT JOIN embeddings e ON e.scrap_id = s.id
    WHERE s.account_id = ? AND TRIM(s.body) != '' AND e.scrap_id IS NULL
    ORDER BY s.created_at
    LIMIT ?
  `).all(accountId, limit);

  let done = 0;
  for (const row of pending) {
    if (await rememberScrap(row.id, row.body)) done += 1;
  }
  return { attempted: pending.length, embedded: done };
}

/**
 * Where "close" starts, and why it is not a cosine you would recognise.
 *
 * Raw cosine does not work on a pile like this. Measured over the first 43
 * scraps -- 820 pairs -- every one scored between 0.559 and 0.904, with a
 * median of 0.678: a 0.35-wide band holding everything from "the same idea two
 * days apart" to "these have nothing to do with each other". Worse, the order
 * inside that band is unreliable. In a four-scrap check, "winter tyres need
 * changing" scored 0.766 against "bought wholemeal flour for bread", while
 * "the starter needs feeding daily" scored 0.747 against the same flour scrap.
 * Unrelated beat related.
 *
 * The reason is that a single person's scraps share almost everything except
 * their subject -- one language, one voice, one register, one set of
 * preoccupations -- and that common component dominates the vector. Subtract
 * the corpus mean and it goes away: the same 820 pairs then span -0.302 to
 * 0.722 with a median of -0.046, so unrelated pairs sit around zero and a real
 * connection stands out. Three times the dynamic range, and the ranking agrees
 * with a human reading of the pairs.
 *
 * 0.30 on the centred score is about the 98th percentile, which comes out at
 * roughly one connection per scrap. That is the intent: a connection should be
 * a small event, not a list.
 */
export const NEAR_THRESHOLD = 0.30;

/**
 * Below this the mean is not worth subtracting.
 *
 * Centring on a handful of vectors is degenerate -- with four scraps the mean
 * absorbs most of each one and every pair came out negative. Connections need
 * a corpus, so below this the honest answer is that there is not enough yet,
 * which is the same rule topics were always going to follow.
 */
export const MIN_CORPUS = 15;

/** Unit-normalised dot product. */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Every vector with the corpus mean removed. */
export function centre(rows) {
  const dims = rows[0].values.length;
  const mean = new Float64Array(dims);
  for (const r of rows) {
    for (let i = 0; i < dims; i++) mean[i] += r.values[i] / rows.length;
  }
  return rows.map((r) => ({
    ...r,
    centred: Float64Array.from(r.values, (v, i) => v - mean[i])
  }));
}

/**
 * The account's vectors, mean removed, or null when there is not enough pile.
 *
 * The single entry point for anything that compares scraps -- connections and
 * clustering both -- so the centring and the corpus floor cannot drift apart
 * between them.
 */
export function centredCorpus(accountId) {
  const loaded = loadVectors(accountId);
  if (loaded.length < MIN_CORPUS) return null;
  return centre(loaded);
}

function loadVectors(accountId) {
  return db.prepare(`
    SELECT e.scrap_id, e.dims, e.vector, s.body, s.created_at, s.image_id, s.audio_id
    FROM embeddings e
    JOIN scraps s ON s.id = e.scrap_id
    WHERE s.account_id = ?
  `).all(accountId).map((r) => ({ ...r, values: unpack(r.vector, r.dims) }));
}

/**
 * What else in the pile is close to this one.
 *
 * `minAgeDays` exists because the interesting connection is rarely the scrap
 * written twenty minutes earlier in the same sitting -- that one you remember.
 * The return visit the app was designed around is "you wrote this today and
 * something close five weeks ago", so recent neighbours can be pushed aside.
 */
export function neighboursOf(accountId, scrapId, { limit = 5, minScore = NEAR_THRESHOLD, minAgeDays = 0 } = {}) {
  const loaded = loadVectors(accountId);
  if (loaded.length < MIN_CORPUS) return [];
  const all = centre(loaded);
  const subject = all.find((r) => r.scrap_id === scrapId);
  if (!subject) return [];

  const subjectAt = Date.parse(subject.created_at);
  const gapMs = minAgeDays * 86400000;

  return all
    .filter((r) => r.scrap_id !== scrapId)
    .filter((r) => Math.abs(Date.parse(r.created_at) - subjectAt) >= gapMs)
    .map((r) => ({
      id: r.scrap_id,
      body: r.body,
      createdAt: r.created_at,
      hasImage: Boolean(r.image_id),
      hasAudio: Boolean(r.audio_id),
      score: cosine(subject.centred, r.centred)
    }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * The closest pair in the whole pile that is not from the same sitting.
 *
 * This is what /api/collide should have been drawing on. Picking two scraps at
 * random and asking a model what connects them makes the model do the work of
 * finding a link that may not exist; picking the two that are already near
 * each other asks it to say something about a connection that does.
 */
export function nearestPair(accountId, { minGapHours = 12, minScore = NEAR_THRESHOLD } = {}) {
  const loaded = loadVectors(accountId);
  if (loaded.length < MIN_CORPUS) return null;
  const all = centre(loaded);

  const gapMs = minGapHours * 3600000;
  let best = null;

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const apart = Math.abs(Date.parse(all[i].created_at) - Date.parse(all[j].created_at));
      if (apart < gapMs) continue;
      const score = cosine(all[i].centred, all[j].centred);
      if (!best || score > best.score) best = { a: all[i], b: all[j], score };
    }
  }

  if (!best || best.score < minScore) return null;
  return {
    score: best.score,
    first: { id: best.a.scrap_id, body: best.a.body, createdAt: best.a.created_at },
    second: { id: best.b.scrap_id, body: best.b.body, createdAt: best.b.created_at }
  };
}

/** How much of the pile can take part in any of this. */
export function coverage(accountId) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM scraps WHERE account_id = ? AND TRIM(body) != '') AS embeddable,
      (SELECT COUNT(*) FROM embeddings e JOIN scraps s ON s.id = e.scrap_id
        WHERE s.account_id = ?) AS embedded
  `).get(accountId, accountId);
  return { embeddable: row.embeddable, embedded: row.embedded };
}
