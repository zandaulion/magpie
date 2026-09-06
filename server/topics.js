/**
 * Magpie — what the pile keeps coming back to.
 *
 * Two things happen here and they are deliberately separate.
 *
 * Clustering *proposes*: it reads the centred vectors and works out which
 * scraps keep company with each other. It runs from scratch every time and
 * owns nothing.
 *
 * Topics *persist*: each proposal is matched against the topics that already
 * exist and reuses the row it most overlaps with. That is what lets a name
 * survive. If a topic were only ever the output of the last clustering run,
 * the name someone typed would dissolve the next time a scrap was added, and
 * naming would be pointless.
 *
 * No model call in any of this. Clustering is arithmetic over vectors already
 * paid for; only asking for a *name* costs anything, and that is on demand.
 */

import crypto from 'node:crypto';
import { db, nowIso } from './db.js';
import { centredCorpus, cosine } from './vectors.js';

/**
 * Where two scraps count as keeping company.
 *
 * Below NEAR_THRESHOLD on purpose. A connection shown on a card should be a
 * small event and is held to a high bar; a topic is a looser thing -- the
 * shape a handful of scraps make together -- and holding it to the same bar
 * produced almost nothing but pairs.
 */
export const TOPIC_LINK = 0.22;

/** Same shape as the ids everywhere else. */
const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

/**
 * Two scraps are a coincidence. Three is a subject.
 *
 * The whole point of topics is the thing you keep returning to, and a pair
 * already has a better home: it shows up as a connection on both cards.
 */
export const MIN_TOPIC_SIZE = 3;

/** How much a proposal must overlap an existing topic to *be* that topic. */
export const SAME_TOPIC_OVERLAP = 0.4;

/**
 * How tightly a group has to hold together to be called a subject.
 *
 * Connected components use single linkage, which chains: A resembles B, B
 * resembles C, and C is dragged in whether or not it has anything to do with
 * A. On the first 43 scraps this pulled eleven into one group whose members
 * averaged 0.16 against each other, where the genuinely tight groups averaged
 * 0.30 and up. Left alone the chaining only gets worse as the pile grows,
 * until everything is one topic called everything.
 *
 * So a group is trimmed of its loosest members until what remains actually
 * coheres, and dropped entirely if nothing does.
 */
export const MIN_COHESION = 0.22;

/**
 * Group the pile, without forcing each scrap into one home.
 *
 * Connected components over the near-graph give the cores. A scrap then joins
 * any other core it fits, which is what makes membership overlapping: a
 * half-formed idea genuinely sits under several things at once, and forcing
 * one home is how it becomes unfindable.
 */
export function proposeClusters(accountId) {
  const rows = centredCorpus(accountId);
  if (!rows) return [];

  const n = rows.length;
  const sim = [];
  for (let i = 0; i < n; i++) {
    sim.push(new Float64Array(n));
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosine(rows[i].centred, rows[j].centred);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  // Cores: connected components of the graph at TOPIC_LINK.
  const seen = new Array(n).fill(false);
  const cores = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    const stack = [i];
    const members = [];
    seen[i] = true;
    while (stack.length) {
      const k = stack.pop();
      members.push(k);
      for (let j = 0; j < n; j++) {
        if (!seen[j] && sim[k][j] >= TOPIC_LINK) {
          seen[j] = true;
          stack.push(j);
        }
      }
    }
    if (members.length >= MIN_TOPIC_SIZE) cores.push(members);
  }

  // Then let anything else join a core it genuinely belongs to, measured
  // against the core as a whole rather than against its nearest member -- one
  // strong edge to an outlier is not membership.
  return cores.map((core) => {
    const set = new Set(core);
    for (let i = 0; i < n; i++) {
      if (set.has(i)) continue;
      let total = 0;
      for (const k of core) total += sim[i][k];
      if (total / core.length >= TOPIC_LINK) set.add(i);
    }

    const members = [...set].map((i) => ({
      id: rows[i].scrap_id,
      body: rows[i].body,
      createdAt: rows[i].created_at,
      // Fit against the rest, kept so a weak assignment can be shown as
      // tentative rather than stated as fact.
      score: (() => {
        const others = [...set].filter((k) => k !== i);
        if (!others.length) return 0;
        return others.reduce((acc, k) => acc + sim[i][k], 0) / others.length;
      })()
    }));

    members.sort((a, b) => b.score - a.score);
    return trimToCohesion(members, sim, rows);
  }).filter(Boolean);
}

/**
 * Drop the loosest members until the group holds together.
 *
 * Scores are recomputed after each removal, because they are each member's fit
 * against the others -- taking one out changes what the rest are being
 * measured against, and a group can tighten sharply once its weakest link is
 * gone.
 */
function trimToCohesion(members, sim, rows) {
  const indexOf = new Map(rows.map((r, i) => [r.scrap_id, i]));
  let current = [...members];

  while (current.length >= MIN_TOPIC_SIZE) {
    const idx = current.map((m) => indexOf.get(m.id));
    const scored = current.map((m, a) => {
      let total = 0;
      for (let b = 0; b < idx.length; b++) if (b !== a) total += sim[idx[a]][idx[b]];
      return { ...m, score: total / (idx.length - 1) };
    });

    const mean = scored.reduce((acc, m) => acc + m.score, 0) / scored.length;
    if (mean >= MIN_COHESION) {
      return scored.sort((a, b) => b.score - a.score);
    }

    scored.sort((a, b) => b.score - a.score);
    current = scored.slice(0, -1);
  }

  // Nothing in here held together well enough to be a subject.
  return null;
}

const jaccard = (a, b) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
};

/**
 * Turn today's proposals into durable rows.
 *
 * A proposal that substantially overlaps an existing topic *is* that topic,
 * grown or shrunk -- so it keeps its id, and with it whatever it is called.
 * Only a genuinely new grouping creates a row. Existing topics that nothing
 * matches are left alone rather than deleted: a subject you have not written
 * about this week has not stopped being a subject.
 */
export function reconcileTopics(accountId) {
  const proposals = proposeClusters(accountId);
  const now = nowIso();

  const existing = db.prepare('SELECT id, name, named_by_user FROM topics WHERE account_id = ?')
    .all(accountId)
    .map((t) => ({
      ...t,
      members: new Set(
        db.prepare('SELECT scrap_id FROM scrap_topics WHERE topic_id = ?')
          .all(t.id).map((r) => r.scrap_id)
      )
    }));

  const claimed = new Set();
  const result = [];

  for (const members of proposals) {
    const ids = new Set(members.map((m) => m.id));

    let best = null;
    for (const topic of existing) {
      if (claimed.has(topic.id)) continue;
      const overlap = jaccard(ids, topic.members);
      if (overlap >= SAME_TOPIC_OVERLAP && (!best || overlap > best.overlap)) {
        best = { topic, overlap };
      }
    }

    let topicId;
    if (best) {
      topicId = best.topic.id;
      claimed.add(topicId);
      db.prepare('UPDATE topics SET updated_at = ? WHERE id = ?').run(now, topicId);
    } else {
      topicId = newId('topic');
      db.prepare(`
        INSERT INTO topics (id, account_id, name, named_by_user, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
      `).run(topicId, accountId, provisionalName(members), now, now);
    }

    // Membership is replaced wholesale: it is derived, unlike the name.
    db.prepare('DELETE FROM scrap_topics WHERE topic_id = ?').run(topicId);
    const add = db.prepare(
      'INSERT INTO scrap_topics (scrap_id, topic_id, score, added_at) VALUES (?, ?, ?, ?)'
    );
    for (const m of members) add.run(m.id, topicId, m.score, now);

    result.push({ id: topicId, size: members.length, reused: Boolean(best) });
  }

  return { topics: result.length, created: result.filter((r) => !r.reused).length };
}

/**
 * Something to call it until it is named properly.
 *
 * The first words of its best-fitting scrap. Deliberately dull: it is a
 * placeholder, and a placeholder that looked like a considered name would stop
 * anyone from replacing it.
 */
function provisionalName(members) {
  const head = (members[0]?.body || '').replace(/\s+/g, ' ').trim();
  if (!head) return 'Fără nume';
  const short = head.split(' ').slice(0, 5).join(' ');
  return short.length < head.length ? `${short}…` : short;
}

/** Topics with their scraps, newest activity first. */
export function listTopics(accountId, { members = 4 } = {}) {
  const topics = db.prepare(`
    SELECT t.id, t.name, t.named_by_user, t.created_at, t.updated_at,
           (SELECT COUNT(*) FROM scrap_topics st WHERE st.topic_id = t.id) AS size
    FROM topics t
    WHERE t.account_id = ?
    ORDER BY t.updated_at DESC
  `).all(accountId);

  return topics.filter((t) => t.size > 0).map((t) => ({
    id: t.id,
    name: t.name,
    namedByUser: Boolean(t.named_by_user),
    size: t.size,
    updatedAt: t.updated_at,
    scraps: db.prepare(`
      SELECT s.id, s.body, s.created_at, st.score
      FROM scrap_topics st JOIN scraps s ON s.id = st.scrap_id
      WHERE st.topic_id = ?
      ORDER BY st.score DESC
      LIMIT ?
    `).all(t.id, members).map((s) => ({
      id: s.id, body: s.body, createdAt: s.created_at, score: s.score
    }))
  }));
}

/** Everything in one topic, for naming it or reading it back. */
export function topicScraps(accountId, topicId, { limit = 30 } = {}) {
  const owned = db.prepare('SELECT id, name, named_by_user FROM topics WHERE id = ? AND account_id = ?')
    .get(topicId, accountId);
  if (!owned) return null;

  // The media columns come along: a scrap that is a photograph is still a
  // scrap, and opening a topic to find its picture missing would be a worse
  // list than the truncated one it replaced.
  const scraps = db.prepare(`
    SELECT s.id, s.body, s.created_at, s.image_id, s.audio_id, st.score
    FROM scrap_topics st JOIN scraps s ON s.id = st.scrap_id
    WHERE st.topic_id = ?
    ORDER BY st.score DESC
    LIMIT ?
  `).all(topicId, limit);

  return { ...owned, scraps };
}

/** A name the person typed. Never overwritten by a later suggestion. */
export function renameTopic(accountId, topicId, name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return null;
  const done = db.prepare(`
    UPDATE topics SET name = ?, named_by_user = 1, updated_at = ?
    WHERE id = ? AND account_id = ?
  `).run(clean, nowIso(), topicId, accountId);
  return done.changes ? clean : null;
}

/** A name Magpie suggested. Only ever applied to a topic nobody has named. */
export function applySuggestedName(accountId, topicId, name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return null;
  const done = db.prepare(`
    UPDATE topics SET name = ?, updated_at = ?
    WHERE id = ? AND account_id = ? AND named_by_user = 0
  `).run(clean, nowIso(), topicId, accountId);
  return done.changes ? clean : null;
}
