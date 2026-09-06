// Magpie's server. Capture and read back; nothing clever yet.
//
// The only job of this first slice is that throwing something in never fails
// and never loses it. Everything Magpie does with the scraps afterwards is
// built on top and can be wrong without costing anything.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { db, nowIso, IMAGE_DIR, AUDIO_DIR } from './db.js';
import { swVersion } from './serve-sw.js';
import {
  echo, collide, transcribe, look, readImageText, nameTopic, extend,
  isConfigured, ModelError
} from './gemini.js';
import { charge, refund, BudgetError } from './budget.js';
import {
  rememberScrap, backfillEmbeddings, neighboursOf, nearestPair, coverage
} from './vectors.js';
import {
  reconcileTopics, listTopics, topicScraps, renameTopic, applySuggestedName,
  scrapsSinceGrouping, MIN_TOPIC_SIZE
} from './topics.js';
import {
  listExtensions, addExtension, editExtension, deleteExtension
} from './extensions.js';
import {
  COOKIE_NAME, requireDevice, requireAdmin, setTokenCookie,
  createInvite, listInvites, revokeInvite, redeemInvite,
  createLinkCode, redeemLinkCode, redeemRecovery, resetRecovery,
  listDevices, listAllDevices, setDeviceRevoked, setDeviceLabel,
  revokeDevice, ThrottledError
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '../web');

const app = express();
app.disable('x-powered-by');
// Scraps are text, but a photographed whiteboard is not small.
app.use(express.json({ limit: '25mb' }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

// ------------------------------------------------------------------ shell

app.get('/bust', (req, res) => {
  // Ahead of express.static, which would otherwise answer this from
  // bust.html without the headers that make it work.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Clear-Site-Data', '"cache"');
  res.sendFile(path.join(WEB_DIR, 'bust.html'));
});

app.use(swVersion(WEB_DIR));
app.use(express.static(WEB_DIR, { extensions: ['html'] }));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    scraps: db.prepare('SELECT COUNT(*) AS n FROM scraps').get().n,
    modelConfigured: isConfigured(),
    devices: db.prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked = 0').get().n,
    time: nowIso()
  });
});

// ------------------------------------------------------------------- auth

app.post('/api/auth/redeem', (req, res) => {
  const result = redeemInvite(req.body?.code, deviceLabel(req.body?.label));
  if (!result) {
    return res.status(400).json({ error: 'bad_code', message: 'Codul nu e valid sau a fost deja folosit.' });
  }
  setTokenCookie(res, result.token);
  // Shown once and never again: it is stored hashed and can only be replaced.
  res.json({
    ok: true,
    accountId: result.accountId,
    deviceId: result.deviceId,
    recoveryCode: result.recoveryCode
  });
});

app.post('/api/auth/link', (req, res) => {
  const result = redeemLinkCode(req.body?.code, deviceLabel(req.body?.label));
  if (!result) {
    return res.status(400).json({ error: 'bad_code', message: 'Codul de legare nu e valid sau a expirat.' });
  }
  setTokenCookie(res, result.token);
  res.json({ ok: true, accountId: result.accountId, deviceId: result.deviceId });
});

app.post('/api/auth/recover', (req, res) => {
  const result = redeemRecovery(req.body?.code, deviceLabel(req.body?.label));
  if (!result) {
    return res.status(400).json({ error: 'bad_code', message: 'Codul de recuperare nu e valid.' });
  }
  setTokenCookie(res, result.token);
  res.json({ ok: true, accountId: result.accountId, deviceId: result.deviceId });
});

app.get('/api/me', requireDevice, (req, res) => {
  res.json({
    accountId: req.device.account_id,
    deviceId: req.device.id,
    label: req.device.label,
    devices: listDevices(req.device.account_id),
    autoEcho: autoEchoFor(req.device.account_id)
  });
});

/**
 * Does Magpie speak first?
 *
 * Read here rather than trusted from the client because it is the client that
 * decides whether to ask, and a preference that only lives in one browser is
 * not a preference -- it is a habit of one device.
 */
function autoEchoFor(accountId) {
  const row = db.prepare('SELECT auto_echo FROM accounts WHERE id = ?').get(accountId);
  return row?.auto_echo !== 0;
}

/**
 * Turning it off does not disable the model, only its habit of speaking
 * unprompted -- POST /api/scraps/:id/echo keeps working, because the button on
 * each card is what the setting leaves behind. So there is deliberately no
 * check for this flag in that route.
 */
app.patch('/api/settings', requireDevice, (req, res) => {
  const { autoEcho } = req.body || {};
  if (typeof autoEcho !== 'boolean') {
    return res.status(400).json({ error: 'bad_request', message: 'autoEcho trebuie sa fie true sau false.' });
  }
  db.prepare('UPDATE accounts SET auto_echo = ? WHERE id = ?')
    .run(autoEcho ? 1 : 0, req.device.account_id);
  res.json({ autoEcho });
});

app.post('/api/devices/link-code', requireDevice, (req, res) => {
  res.json(createLinkCode(req.device.account_id));
});

app.post('/api/devices/recovery', requireDevice, (req, res) => {
  res.json({ recoveryCode: resetRecovery(req.device.account_id) });
});

app.post('/api/devices/:id/revoke', requireDevice, (req, res) => {
  if (req.params.id === req.device.id) {
    return res.status(400).json({ error: 'self', message: 'Folosește alt dispozitiv ca să-l scoți pe acesta.' });
  }
  if (!revokeDevice(req.device.account_id, req.params.id)) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.json({ ok: true });
});

function deviceLabel(value) {
  const s = String(value || '').trim().slice(0, 40);
  return s || null;
}

// ----------------------------------------------------------------- scraps

/**
 * Throw something in.
 *
 * Deliberately the least demanding route in the app: text, or an image, or
 * both, and nothing else is asked for. No title, no category, no tags. The
 * moment there is a required field, the promise of frictionless capture is
 * gone, and a thought that takes effort to record is a thought that does not
 * get recorded.
 */
app.post('/api/scraps', requireDevice, (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const image = typeof req.body?.image === 'string' ? req.body.image : null;
  const audioId = typeof req.body?.audioId === 'string' ? req.body.audioId : null;

  if (!body && !image && !audioId) {
    return res.status(400).json({ error: 'empty', message: 'Nimic de păstrat.' });
  }

  let imageId = null;
  if (image) {
    const ext = req.body?.mimeType === 'image/png' ? 'png' : 'jpg';
    imageId = `${newId('img')}.${ext}`;
    fs.writeFileSync(path.join(IMAGE_DIR, imageId), Buffer.from(image, 'base64'));
  }

  const id = newId('scrap');
  const now = nowIso();
  db.prepare(`
    INSERT INTO scraps (id, account_id, device_id, body, image_id, audio_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.device.account_id, req.device.id, body, imageId, audioId, now);

  res.status(201).json(scrapForApi(db.prepare('SELECT * FROM scraps WHERE id = ?').get(id)));

  // After the response, deliberately. The vector is what makes a scrap findable
  // later, but nothing about saving it should wait on a network call -- and a
  // model outage must never turn into a failure to keep what someone wrote.
  // Anything missed here is picked up by the backfill.
  if (body) rememberScrap(id, body);
});

/**
 * What the pile adds up to.
 *
 * Descriptive on purpose. There are no streaks here, no daily average dressed
 * up as a target, and no sentence about a day being empty -- the app is for
 * someone who already has enough things telling him he is behind, and a
 * counter that can be failed would turn a scratchpad into another one of them.
 * Everything below answers "what does this look like", never "how are you
 * doing".
 *
 * Days and hours are bucketed in the reader's own timezone, which the client
 * sends, because a thought at half past midnight belongs to the night it
 * happened in and not to the UTC day it landed on.
 */
app.get('/api/stats', requireDevice, (req, res) => {
  const account = req.device.account_id;
  // Minutes east of UTC, as the client computes it. Clamped to the real range
  // of world offsets so the value cannot be used to shift the query anywhere
  // interesting.
  const tz = Math.max(-840, Math.min(840, Math.trunc(Number(req.query.tz)) || 0));
  const shift = `${tz >= 0 ? '+' : '-'}${Math.abs(tz)} minutes`;
  const local = "datetime(created_at, ?)";

  const one = (sql, ...args) => db.prepare(sql).get(account, ...args);

  const total = one('SELECT COUNT(*) AS n FROM scraps WHERE account_id = ?').n;
  if (!total) {
    return res.json({ total: 0, kinds: { text: 0, photo: 0, voice: 0 },
                      byDay: [], byHour: new Array(24).fill(0),
                      echoes: 0, collisions: 0, firstAt: null, days: 0, busiest: null });
  }

  // A scrap can be more than one thing at once -- a photograph with a line
  // typed under it is both -- so these deliberately do not sum to the total.
  const kinds = {
    text: one("SELECT COUNT(*) AS n FROM scraps WHERE account_id = ? AND TRIM(body) <> ''").n,
    photo: one('SELECT COUNT(*) AS n FROM scraps WHERE account_id = ? AND image_id IS NOT NULL').n,
    voice: one('SELECT COUNT(*) AS n FROM scraps WHERE account_id = ? AND audio_id IS NOT NULL').n
  };

  const counted = db.prepare(
    `SELECT date(${local}) AS day, COUNT(*) AS n FROM scraps
     WHERE account_id = ? GROUP BY day`
  ).all(shift, account);
  const perDay = new Map(counted.map((r) => [r.day, r.n]));

  // Fourteen days ending today, gaps included. A missing day is part of the
  // shape and is not the same thing as a day that never existed.
  const today = new Date(Date.now() + tz * 60000);
  const byDay = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    byDay.push({ day: key, n: perDay.get(key) || 0 });
  }

  const byHour = new Array(24).fill(0);
  for (const r of db.prepare(
    `SELECT CAST(strftime('%H', ${local}) AS INTEGER) AS h, COUNT(*) AS n
     FROM scraps WHERE account_id = ? GROUP BY h`
  ).all(shift, account)) byHour[r.h] = r.n;

  const busiest = counted.reduce((best, r) => (!best || r.n > best.n ? r : best), null);
  const first = one('SELECT MIN(created_at) AS at FROM scraps WHERE account_id = ?').at;

  res.json({
    total,
    kinds,
    byDay,
    byHour,
    busiest,
    firstAt: first,
    // How many separate days have anything in them -- not a streak, and not
    // out of anything.
    days: counted.length,
    echoes: one(`SELECT COUNT(*) AS n FROM echoes e
                 JOIN scraps s ON s.id = e.scrap_id WHERE s.account_id = ?`).n,
    collisions: one('SELECT COUNT(*) AS n FROM collisions WHERE account_id = ?').n
  });
});

app.get('/api/scraps', requireDevice, (req, res) => {
  // A cursor rather than a page number: scraps only ever get added at the
  // front, so an offset would shift under a list being scrolled.
  const before = typeof req.query.before === 'string' ? req.query.before : null;
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const rows = before
    ? db.prepare(`SELECT * FROM scraps WHERE account_id = ? AND created_at < ?
                  ORDER BY created_at DESC LIMIT ?`).all(req.device.account_id, before, limit)
    : db.prepare(`SELECT * FROM scraps WHERE account_id = ?
                  ORDER BY created_at DESC LIMIT ?`).all(req.device.account_id, limit);

  res.json({
    scraps: rows.map(scrapForApi),
    total: db.prepare('SELECT COUNT(*) AS n FROM scraps WHERE account_id = ?').get(req.device.account_id).n
  });
});

app.delete('/api/scraps/:id', requireDevice, (req, res) => {
  const row = db.prepare('SELECT * FROM scraps WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.device.account_id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  db.prepare('DELETE FROM scraps WHERE id = ?').run(row.id);
  if (row.image_id) {
    // The picture is theirs; deleting the scrap deletes it too rather than
    // orphaning it on disk.
    try { fs.unlinkSync(path.join(IMAGE_DIR, row.image_id)); } catch {}
  }
  if (row.audio_id) {
    try { fs.unlinkSync(path.join(AUDIO_DIR, row.audio_id)); } catch {}
  }
  res.json({ ok: true });
});

app.get('/api/images/:id', requireDevice, (req, res) => {
  const owned = db.prepare('SELECT 1 FROM scraps WHERE image_id = ? AND account_id = ?')
    .get(req.params.id, req.device.account_id);
  if (!owned) return res.status(404).end();

  const file = path.join(IMAGE_DIR, path.basename(req.params.id));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type(file.endsWith('.png') ? 'image/png' : 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
});

function scrapForApi(row) {
  const said = db.prepare('SELECT body FROM echoes WHERE scrap_id = ?').get(row.id);
  return {
    id: row.id,
    body: row.body,
    imageId: row.image_id,
    audioId: row.audio_id,
    createdAt: row.created_at,
    // Magpie's words, kept separate from theirs all the way to the client so
    // the interface can never render the two as one thing.
    echo: said?.body || null
  };
}

// ------------------------------------------------------------ magpie says

/**
 * One short thing back, on a single scrap.
 *
 * Separate from the save on purpose. Saving must never wait on a model or fail
 * because one was slow -- the scrap is already kept by the time this is asked
 * for, so a model that is down costs a remark and nothing else.
 */
app.post('/api/scraps/:id/echo', requireDevice, asyncRoute(async (req, res) => {
  const scrap = db.prepare('SELECT * FROM scraps WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.device.account_id);
  if (!scrap) return res.status(404).json({ error: 'not_found' });
  if (!scrap.body && !scrap.image_id) return res.status(400).json({ error: 'nothing_to_read' });

  const already = db.prepare('SELECT body FROM echoes WHERE scrap_id = ?').get(scrap.id);
  if (already) return res.json({ echo: already.body });

  charge(req.device.account_id);
  let said;
  try {
    // A photograph is looked at rather than read: the picture carries the sense
    // and whatever was typed beside it is context, not the subject.
    if (scrap.image_id) {
      const file = path.join(IMAGE_DIR, scrap.image_id);
      said = await look(
        fs.readFileSync(file).toString('base64'),
        scrap.image_id.endsWith('.png') ? 'image/png' : 'image/jpeg',
        scrap.body
      );
    } else {
      said = await echo(scrap.body);
    }
  } catch (err) {
    if (err.status === 503 || err.status === 429) refund(req.device.account_id);
    throw err;
  }

  db.prepare('INSERT INTO echoes (scrap_id, body, model, created_at) VALUES (?, ?, ?, ?)')
    .run(scrap.id, said.text, said.model, nowIso());
  res.json({ echo: said.text });
}));

/**
 * What else you have written that is close to this one.
 *
 * No model call. The vectors were paid for when each scrap was saved, and this
 * is cosine similarity over them -- which is what makes it cheap enough to
 * offer on every scrap rather than behind a button with a budget attached.
 *
 * `days` pushes aside the neighbours from the same sitting. The scrap written
 * twenty minutes ago you already remember; the one from five weeks back is the
 * return visit this app was built for.
 */
app.get('/api/scraps/:id/near', requireDevice, (req, res) => {
  const scrap = db.prepare('SELECT id FROM scraps WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.device.account_id);
  if (!scrap) return res.status(404).json({ error: 'not_found' });

  const days = Number(req.query.days);
  const near = neighboursOf(req.device.account_id, req.params.id, {
    limit: Math.min(Number(req.query.limit) || 5, 20),
    minAgeDays: Number.isFinite(days) ? days : 0
  });

  res.json({ near, coverage: coverage(req.device.account_id) });
});

/**
 * Give the pile its vectors.
 *
 * Idempotent, and safe to call repeatedly: it only looks at scraps that have
 * text and no vector. Needed once for everything written before embedding
 * existed, and useful afterwards for anything a model outage missed.
 */
app.post('/api/embeddings/backfill', requireDevice, asyncRoute(async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'not_configured', message: 'Nu e configurat niciun model.' });
  }
  // Deliberately not charged against the daily budget: embedding is the
  // substrate, and rationing it would ration the thing the app is for.
  const result = await backfillEmbeddings(req.device.account_id);
  res.json({ ...result, coverage: coverage(req.device.account_id) });
}));

/**
 * What the pile keeps coming back to.
 *
 * Reads what is already stored rather than re-clustering, so opening the list
 * is instant and does not quietly rearrange itself under whoever is reading
 * it. Clustering is a thing you ask for, below.
 */
app.get('/api/topics', requireDevice, (req, res) => {
  res.json({
    topics: listTopics(req.device.account_id),
    minSize: MIN_TOPIC_SIZE,
    sinceGrouping: scrapsSinceGrouping(req.device.account_id),
    coverage: coverage(req.device.account_id)
  });
});

/**
 * Look again.
 *
 * Free: clustering is arithmetic over vectors already paid for. A topic that
 * substantially overlaps one that exists keeps its id and its name; only a
 * genuinely new grouping makes a new row.
 */
app.post('/api/topics/recluster', requireDevice, (req, res) => {
  const summary = reconcileTopics(req.device.account_id);
  res.json({
    ...summary,
    topics: listTopics(req.device.account_id),
    sinceGrouping: scrapsSinceGrouping(req.device.account_id)
  });
});

/** A name the person typed. */
app.patch('/api/topics/:id', requireDevice, (req, res) => {
  const name = renameTopic(req.device.account_id, req.params.id, req.body?.name);
  if (!name) return res.status(400).json({ error: 'bad_name' });
  res.json({ id: req.params.id, name, namedByUser: true });
});

/**
 * Ask Magpie what to call it.
 *
 * Charged, unlike everything else about topics, because it is the only part
 * that reaches a model. Refuses on a topic that already has a name someone
 * typed: a suggestion never overwrites a person's own word for their own
 * subject.
 */
app.post('/api/topics/:id/name', requireDevice, asyncRoute(async (req, res) => {
  const topic = topicScraps(req.device.account_id, req.params.id);
  if (!topic) return res.status(404).json({ error: 'not_found' });
  if (topic.named_by_user) {
    return res.status(409).json({
      error: 'already_named',
      message: 'I-ai dat deja un nume. Schimbă-l tu dacă nu mai e bun.'
    });
  }

  charge(req.device.account_id);
  let out;
  try {
    out = await nameTopic(topic.scraps.map((s) => s.body));
  } catch (err) {
    if (err.status === 503 || err.status === 429) refund(req.device.account_id);
    throw err;
  }

  const name = applySuggestedName(req.device.account_id, req.params.id, out.name);
  res.json({ id: req.params.id, name: name || topic.name, namedByUser: false });
}));

/**
 * Everything in a topic, not the handful the list previews.
 *
 * Its own route rather than a bigger payload on /api/topics: most topics are
 * never opened, and sending every scrap of every one of them to draw four
 * truncated lines each would be most of the pile on every visit.
 */
app.get('/api/topics/:id/scraps', requireDevice, (req, res) => {
  const topic = topicScraps(req.device.account_id, req.params.id, { limit: 200 });
  if (!topic) return res.status(404).json({ error: 'not_found' });
  res.json({
    name: topic.name,
    scraps: topic.scraps.map((s) => ({
      id: s.id, body: s.body, createdAt: s.created_at, score: s.score,
      imageId: s.image_id, audioId: s.audio_id
    }))
  });
});

/** What has been written about a topic, Magpie's and yours alike. */
app.get('/api/topics/:id/extensions', requireDevice, (req, res) => {
  const list = listExtensions(req.device.account_id, req.params.id);
  if (!list) return res.status(404).json({ error: 'not_found' });
  res.json({ extensions: list });
});

/**
 * Ask Magpie to read the topic.
 *
 * Always adds; never replaces. A second reading sits beside the first rather
 * than over it, which is what makes it safe to edit one -- and the reason it
 * is worth asking twice at all, since the two will not agree.
 */
app.post('/api/topics/:id/extend', requireDevice, asyncRoute(async (req, res) => {
  const topic = topicScraps(req.device.account_id, req.params.id);
  if (!topic) return res.status(404).json({ error: 'not_found' });

  charge(req.device.account_id);
  let out;
  try {
    out = await extend(topic.name, topic.scraps.map((s) => s.body));
  } catch (err) {
    if (err.status === 503 || err.status === 429) refund(req.device.account_id);
    // A call that came back with nothing has to be refunded too. It happened
    // on real content -- a topic the model would not write about, silently and
    // every time -- and without this a budget could be spent to a standstill
    // on a topic that will never answer. Reported plainly rather than as a
    // 502, because nothing is broken: Magpie had nothing to say.
    if (err.code === 'empty' || err.code === 'truncated') {
      refund(req.device.account_id);
      return res.status(200).json({
        extension: null,
        nothingToSay: true,
        message: 'Magpie n-a avut nimic de spus despre asta. Mai încearcă după ce mai arunci câteva.'
      });
    }
    throw err;
  }

  const saved = addExtension(req.device.account_id, req.params.id, out.text, out.model);
  if (!saved) return res.status(502).json({ error: 'unreadable' });
  res.status(201).json({ extension: saved });
}));

/**
 * Your words now.
 *
 * The edit is what flips `mine`, and nothing ever flips it back: once someone
 * has been in there, the row stops being the model's however much of the
 * original survives.
 */
app.patch('/api/extensions/:id', requireDevice, (req, res) => {
  const saved = editExtension(req.device.account_id, req.params.id, req.body?.body);
  if (!saved) return res.status(404).json({ error: 'not_found' });
  res.json({ extension: saved });
});

app.delete('/api/extensions/:id', requireDevice, (req, res) => {
  if (!deleteExtension(req.device.account_id, req.params.id)) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.status(204).end();
});

/**
 * Two scraps, knocked together.
 *
 * Wants a pair and nothing more, which is why it is here so early: clustering
 * needs dozens before it can say anything honest, and this needs two.
 */
app.post('/api/collide', requireDevice, asyncRoute(async (req, res) => {
  // The closest pair that is not from the same sitting, where the vectors can
  // find one. Two scraps drawn at random are usually unrelated, and asking a
  // model what connects them makes it invent a link; asking it about a pair
  // that is already near each other asks it to describe a real one.
  //
  // Falls back to random, because a pile with no vectors yet -- a model
  // outage, a brand new account -- should still be able to collide.
  const near = nearestPair(req.device.account_id);
  const pool = near
    ? [near.first, near.second]
    : db.prepare(`
        SELECT id, body FROM scraps
        WHERE account_id = ? AND body != ''
        ORDER BY RANDOM() LIMIT 2
      `).all(req.device.account_id);

  if (pool.length < 2) {
    return res.status(400).json({
      error: 'need_two',
      message: 'Mai aruncă unul și Magpie poate începe să le ciocnească.'
    });
  }

  charge(req.device.account_id);
  let out;
  try {
    out = await collide(pool[0].body, pool[1].body);
  } catch (err) {
    if (err.status === 503 || err.status === 429) refund(req.device.account_id);
    throw err;
  }

  const id = newId('col');
  db.prepare(`
    INSERT INTO collisions (id, account_id, a_id, b_id, body, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.device.account_id, pool[0].id, pool[1].id, out.text, out.model, nowIso());

  res.json({
    id,
    body: out.text,
    a: { id: pool[0].id, body: pool[0].body },
    b: { id: pool[1].id, body: pool[1].body }
  });
}));

// ------------------------------------------------------------------- voice

/**
 * A recording, and a reading of it.
 *
 * The audio is written to disk before the model is asked anything, and stays
 * there afterwards. It is what the person actually produced; the transcript is
 * Magpie's reading of it and can be wrong, so throwing the recording away once
 * text existed would turn a bad transcript into a lost thought.
 *
 * Returns the transcript for the capture box rather than saving a scrap
 * outright -- what is heard should be seen before it is kept.
 */
app.post('/api/voice', requireDevice, asyncRoute(async (req, res) => {
  const audio = typeof req.body?.audio === 'string' ? req.body.audio : null;
  if (!audio || audio.length < 100) {
    return res.status(400).json({ error: 'no_audio', message: 'Nu s-a înregistrat nimic.' });
  }

  const mime = typeof req.body?.mimeType === 'string' ? req.body.mimeType : 'audio/webm';
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';
  const audioId = `${newId('aud')}.${ext}`;
  fs.writeFileSync(path.join(AUDIO_DIR, audioId), Buffer.from(audio, 'base64'));

  charge(req.device.account_id);
  let heard;
  try {
    heard = await transcribe(audio, mime);
  } catch (err) {
    if (err.status === 503 || err.status === 429) refund(req.device.account_id);
    // The recording is already on disk, so the words are not lost even though
    // the reading of them failed.
    return res.status(err.status || 502).json({ error: err.code, message: err.message, audioId });
  }

  res.json({ audioId, text: heard.text });
}));

/**
 * The words out of a photograph.
 *
 * Same shape as voice: this reads a picture that has not been saved yet and
 * hands the text back for the box, so it can be looked at before anything is
 * kept. The picture is not written to disk here -- it is still only attached
 * to the composer, and it is stored when the scrap is.
 */
app.post('/api/photo/read', requireDevice, asyncRoute(async (req, res) => {
  const image = typeof req.body?.image === 'string' ? req.body.image : null;
  if (!image || image.length < 100) {
    return res.status(400).json({ error: 'no_image', message: 'Nicio poză.' });
  }

  charge(req.device.account_id);
  let heard;
  try {
    heard = await readImageText(image, req.body?.mimeType || 'image/jpeg');
  } catch (err) {
    if (err.status === 503 || err.status === 429) refund(req.device.account_id);
    throw err;
  }
  res.json({ text: heard.text });
}));

app.get('/api/audio/:id', requireDevice, (req, res) => {
  const owned = db.prepare('SELECT 1 FROM scraps WHERE audio_id = ? AND account_id = ?')
    .get(req.params.id, req.device.account_id);
  if (!owned) return res.status(404).end();

  const file = path.join(AUDIO_DIR, path.basename(req.params.id));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type(file.endsWith('.mp4') ? 'audio/mp4' : file.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
});

// ------------------------------------------------------------------ admin

// listInvites already returns the console's envelope; wrapping it again
// would nest it a level deeper than the contract.
app.get('/api/admin/invites', requireAdmin, (req, res) => res.json(listInvites()));

app.post('/api/admin/invites', requireAdmin, (req, res) => {
  res.status(201).json(createInvite(deviceLabel(req.body?.label)));
});

app.post('/api/admin/invites/:id/revoke', requireAdmin, (req, res) => {
  if (!revokeInvite(Number(req.params.id))) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.get('/api/admin/devices', requireAdmin, (req, res) => res.json({ devices: listAllDevices() }));

app.post('/api/admin/devices/:id/revoke', requireAdmin, (req, res) => {
  setDeviceRevoked(req.params.id, req.body?.revoked);
  res.json({ ok: true });
});

app.post('/api/admin/devices/:id/label', requireAdmin, (req, res) => {
  setDeviceLabel(req.params.id, deviceLabel(req.body?.label));
  res.json({ ok: true });
});

app.delete('/api/admin/devices/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ errors

app.use((err, req, res, next) => {
  if (err instanceof ModelError || err instanceof BudgetError || err instanceof ThrottledError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  console.error('unhandled', err);
  res.status(500).json({ error: 'internal', message: 'Ceva n-a mers pe server.' });
});

// Loopback by default, so running this directly never exposes it by accident.
// In a container the namespace's own interface has to be bound to be reachable
// at all, which is why the quadlet sets HOST.
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => console.log(`magpie on ${HOST}:${PORT}`));
}

export { app };
