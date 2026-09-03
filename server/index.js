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

import { db, nowIso, IMAGE_DIR } from './db.js';
import { swVersion } from './serve-sw.js';
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
app.use(express.json({ limit: '12mb' }));

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
    devices: db.prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked = 0').get().n,
    time: nowIso()
  });
});

// ------------------------------------------------------------------- auth

app.post('/api/auth/redeem', (req, res) => {
  const result = redeemInvite(req.body?.code, deviceLabel(req.body?.label));
  if (!result) {
    return res.status(400).json({ error: 'bad_code', message: 'That code is not valid, or has already been used.' });
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
    return res.status(400).json({ error: 'bad_code', message: 'That link code is not valid or has expired.' });
  }
  setTokenCookie(res, result.token);
  res.json({ ok: true, accountId: result.accountId, deviceId: result.deviceId });
});

app.post('/api/auth/recover', (req, res) => {
  const result = redeemRecovery(req.body?.code, deviceLabel(req.body?.label));
  if (!result) {
    return res.status(400).json({ error: 'bad_code', message: 'That recovery code is not valid.' });
  }
  setTokenCookie(res, result.token);
  res.json({ ok: true, accountId: result.accountId, deviceId: result.deviceId });
});

app.get('/api/me', requireDevice, (req, res) => {
  res.json({
    accountId: req.device.account_id,
    deviceId: req.device.id,
    label: req.device.label,
    devices: listDevices(req.device.account_id)
  });
});

app.post('/api/devices/link-code', requireDevice, (req, res) => {
  res.json(createLinkCode(req.device.account_id));
});

app.post('/api/devices/recovery', requireDevice, (req, res) => {
  res.json({ recoveryCode: resetRecovery(req.device.account_id) });
});

app.post('/api/devices/:id/revoke', requireDevice, (req, res) => {
  if (req.params.id === req.device.id) {
    return res.status(400).json({ error: 'self', message: 'Use another device to sign this one out.' });
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

  if (!body && !image) {
    return res.status(400).json({ error: 'empty', message: 'Nothing to keep.' });
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
    INSERT INTO scraps (id, account_id, device_id, body, image_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.device.account_id, req.device.id, body, imageId, now);

  res.status(201).json(scrapForApi(db.prepare('SELECT * FROM scraps WHERE id = ?').get(id)));
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
  return {
    id: row.id,
    body: row.body,
    imageId: row.image_id,
    createdAt: row.created_at
  };
}

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
  if (err instanceof ThrottledError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  console.error('unhandled', err);
  res.status(500).json({ error: 'internal', message: 'Something went wrong on the server.' });
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
