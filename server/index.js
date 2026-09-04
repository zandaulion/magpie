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
import { echo, collide, transcribe, look, readImageText, isConfigured, ModelError } from './gemini.js';
import { charge, refund, BudgetError } from './budget.js';
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
 * Two scraps, knocked together.
 *
 * Wants a pair and nothing more, which is why it is here so early: clustering
 * needs dozens before it can say anything honest, and this needs two.
 */
app.post('/api/collide', requireDevice, asyncRoute(async (req, res) => {
  const pool = db.prepare(`
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
