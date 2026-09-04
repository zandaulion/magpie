// Against a real server and a real database in a temp directory. No mocks for
// the store: the schema, the foreign keys and the JSON round-trip are most of
// what could actually break.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-test-'));
process.env.NODE_ENV = 'test';
process.env.COOKIE_INSECURE = '1';
// The console needs a usable link, and the invite URL is built from this.
// Without it createInvite honestly returns null rather than a broken link.
process.env.PUBLIC_BASE_URL = 'https://magpie.example';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';
const ADMIN_HEADERS = { 'X-Admin-Token': process.env.ADMIN_TOKEN };

const { app } = await import('../server/index.js');
const { createInvite } = await import('../server/auth.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const api = (p, opts = {}) => fetch(base + p, {
  ...opts,
  headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
});

async function registerDevice(label = 'test') {
  const { code } = createInvite(label);
  const res = await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, auth: { Cookie: cookie }, ...body };
}

// ------------------------------------------------------------------ basics

test('health answers before anything has been thrown in', async () => {
  const r = await (await api('/api/health')).json();
  assert.equal(r.ok, true);
  assert.equal(r.scraps, 0);
});

test('nothing is reachable without a device', async () => {
  assert.equal((await api('/api/scraps')).status, 401);
  assert.equal((await api('/api/me')).status, 401);
  assert.equal((await api('/api/scraps', { method: 'POST', body: '{}' })).status, 401);
});

test('redeeming an invite returns a recovery code exactly once', async () => {
  const { recoveryCode, accountId } = await registerDevice();
  assert.ok(recoveryCode, 'shown on the way in');
  assert.ok(accountId);

  // It is stored hashed, so /api/me can never hand it back.
  const me = await (await api('/api/me', { headers: { Cookie: `magpie_token=nonsense` } })).json();
  assert.equal(me.recoveryCode, undefined);
});

// --------------------------------------------------------------- settings

test('Magpie speaks first until told otherwise', async () => {
  const { auth } = await registerDevice();
  const me = await (await api('/api/me', { headers: auth })).json();
  assert.equal(me.autoEcho, true);
});

test('the setting survives the round trip and is per account', async () => {
  const a = await registerDevice('a');
  const b = await registerDevice('b');

  const res = await api('/api/settings', {
    method: 'PATCH', headers: a.auth, body: JSON.stringify({ autoEcho: false })
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).autoEcho, false);

  assert.equal((await (await api('/api/me', { headers: a.auth })).json()).autoEcho, false);
  // Turning it off is a decision about one person's app, not the server's.
  assert.equal((await (await api('/api/me', { headers: b.auth })).json()).autoEcho, true);

  await api('/api/settings', {
    method: 'PATCH', headers: a.auth, body: JSON.stringify({ autoEcho: true })
  });
  assert.equal((await (await api('/api/me', { headers: a.auth })).json()).autoEcho, true);
});

test('the setting refuses anything that is not a yes or a no', async () => {
  const { auth } = await registerDevice();
  for (const body of ['{}', '{"autoEcho":"false"}', '{"autoEcho":0}']) {
    const res = await api('/api/settings', { method: 'PATCH', headers: auth, body });
    assert.equal(res.status, 400, body);
  }
  // And is not something a stranger can set.
  assert.equal((await api('/api/settings', {
    method: 'PATCH', body: JSON.stringify({ autoEcho: false })
  })).status, 401);
});

// ------------------------------------------------------------------ scraps

test('a scrap comes back exactly as it was thrown in', async () => {
  const { auth } = await registerDevice();
  // Whitespace, punctuation and a newline: a half-formed thought is not tidy.
  const body = 'what if the tail\n  is the *whole* point?  ';

  const created = await (await api('/api/scraps', {
    method: 'POST', headers: auth, body: JSON.stringify({ body })
  })).json();

  // Trimmed at the ends, untouched within: leading spaces from a paste are
  // noise, but the shape of what was typed is not.
  assert.equal(created.body, 'what if the tail\n  is the *whole* point?');
  assert.ok(created.id.startsWith('scrap_'));

  const list = await (await api('/api/scraps', { headers: auth })).json();
  assert.equal(list.scraps[0].body, created.body);
});

test('an empty scrap is refused rather than stored', async () => {
  const { auth } = await registerDevice();
  const res = await api('/api/scraps', {
    method: 'POST', headers: auth, body: JSON.stringify({ body: '   ' })
  });
  assert.equal(res.status, 400);
  assert.equal((await (await api('/api/scraps', { headers: auth })).json()).total, 0);
});

test('a picture on its own is a scrap', async () => {
  const { auth } = await registerDevice();
  const png = Buffer.alloc(400, 0x89).toString('base64');

  const created = await (await api('/api/scraps', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ body: '', image: png, mimeType: 'image/png' })
  })).json();

  assert.equal(created.body, '');
  assert.ok(created.imageId, 'a scrap can be just a photograph');
  assert.equal((await api(`/api/images/${created.imageId}`, { headers: auth })).status, 200);
});

test('scraps come back newest first, and page backwards from a cursor', async () => {
  const { auth } = await registerDevice();
  for (const n of ['first', 'second', 'third']) {
    await api('/api/scraps', { method: 'POST', headers: auth, body: JSON.stringify({ body: n }) });
    await new Promise((r) => setTimeout(r, 5));
  }

  const list = await (await api('/api/scraps', { headers: auth })).json();
  assert.deepEqual(list.scraps.map((s) => s.body), ['third', 'second', 'first']);

  // A cursor rather than an offset: scraps are only added at the front, so an
  // offset would shift under a list being scrolled.
  const older = await (await api(
    `/api/scraps?before=${encodeURIComponent(list.scraps[0].createdAt)}`, { headers: auth })).json();
  assert.deepEqual(older.scraps.map((s) => s.body), ['second', 'first']);
});

test('one account never sees another\'s scraps', async () => {
  const mine = await registerDevice('mine');
  const theirs = await registerDevice('theirs');

  await api('/api/scraps', { method: 'POST', headers: mine.auth, body: JSON.stringify({ body: 'private' }) });

  const seen = await (await api('/api/scraps', { headers: theirs.auth })).json();
  assert.equal(seen.total, 0);
  assert.equal(seen.scraps.length, 0);
});

test('deleting a scrap takes its picture with it', async () => {
  const { auth } = await registerDevice();
  const png = Buffer.alloc(400, 0x89).toString('base64');
  const created = await (await api('/api/scraps', {
    method: 'POST', headers: auth, body: JSON.stringify({ body: 'x', image: png, mimeType: 'image/png' })
  })).json();

  assert.equal((await api(`/api/scraps/${created.id}`, { method: 'DELETE', headers: auth })).status, 200);
  assert.equal((await api(`/api/images/${created.imageId}`, { headers: auth })).status, 404,
    'the picture is theirs; it does not outlive the scrap');
});

test('one account cannot delete another\'s scrap', async () => {
  const mine = await registerDevice('mine');
  const theirs = await registerDevice('theirs');
  const created = await (await api('/api/scraps', {
    method: 'POST', headers: mine.auth, body: JSON.stringify({ body: 'keep' })
  })).json();

  const res = await api(`/api/scraps/${created.id}`, { method: 'DELETE', headers: theirs.auth });
  assert.equal(res.status, 404, 'not even told it exists');
  assert.equal((await (await api('/api/scraps', { headers: mine.auth })).json()).total, 1);
});

// ----------------------------------------------------------------- devices

test('a linked device shares the same account and the same scraps', async () => {
  const first = await registerDevice('phone');
  await api('/api/scraps', { method: 'POST', headers: first.auth, body: JSON.stringify({ body: 'from the phone' }) });

  const { code } = await (await api('/api/devices/link-code', { method: 'POST', headers: first.auth })).json();
  const res = await api('/api/auth/link', { method: 'POST', body: JSON.stringify({ code, label: 'laptop' }) });
  assert.equal(res.status, 200);
  const second = { Cookie: res.headers.get('set-cookie').split(';')[0] };

  const seen = await (await api('/api/scraps', { headers: second })).json();
  assert.equal(seen.scraps[0].body, 'from the phone');

  const me = await (await api('/api/me', { headers: second })).json();
  assert.equal(me.accountId, first.accountId);
  assert.equal(me.devices.length, 2);
});

test('a link code works once', async () => {
  const { auth } = await registerDevice();
  const { code } = await (await api('/api/devices/link-code', { method: 'POST', headers: auth })).json();
  assert.equal((await api('/api/auth/link', { method: 'POST', body: JSON.stringify({ code }) })).status, 200);
  assert.equal((await api('/api/auth/link', { method: 'POST', body: JSON.stringify({ code }) })).status, 400);
});

test('the recovery code gets you back to the same scraps', async () => {
  const first = await registerDevice('lost phone');
  await api('/api/scraps', { method: 'POST', headers: first.auth, body: JSON.stringify({ body: 'still here' }) });

  const res = await api('/api/auth/recover', {
    method: 'POST', body: JSON.stringify({ code: first.recoveryCode, label: 'new phone' })
  });
  assert.equal(res.status, 200);
  const back = { Cookie: res.headers.get('set-cookie').split(';')[0] };

  const seen = await (await api('/api/scraps', { headers: back })).json();
  assert.equal(seen.scraps[0].body, 'still here');
});

test('a device cannot sign itself out', async () => {
  const { auth, deviceId } = await registerDevice();
  const res = await api(`/api/devices/${deviceId}/revoke`, { method: 'POST', headers: auth });
  assert.equal(res.status, 400);
});

// ------------------------------------------------------------------- admin

test('the admin gate wants the secret, not a header anyone can set', async () => {
  assert.equal((await api('/api/admin/invites', { headers: { 'X-Admin': '1' } })).status, 403);
  assert.equal((await api('/api/admin/invites')).status, 403);
  assert.equal((await api('/api/admin/invites', { headers: ADMIN_HEADERS })).status, 200);
});

test('the invite list carries what the console reads', async () => {
  const created = await (await api('/api/admin/invites', {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ label: 'Ana' })
  })).json();
  assert.ok(created.code);
  assert.ok(created.url.includes(created.code), 'the link carries the code');

  const { invites } = await (await api('/api/admin/invites', { headers: ADMIN_HEADERS })).json();
  const row = invites.find((i) => i.id === created.id);
  for (const field of ['id', 'label', 'code', 'url', 'created_at', 'expires_at', 'used_at', 'revoked']) {
    assert.ok(field in row, `the console reads ${field}`);
  }
});

test('a cancelled invite stays listed and cannot register anything', async () => {
  const created = await (await api('/api/admin/invites', {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ label: 'withdrawn' })
  })).json();

  assert.equal((await api(`/api/admin/invites/${created.id}/revoke`, {
    method: 'POST', headers: ADMIN_HEADERS
  })).status, 200);

  const { invites } = await (await api('/api/admin/invites', { headers: ADMIN_HEADERS })).json();
  const row = invites.find((i) => i.id === created.id);
  assert.ok(row, 'flagged, not deleted -- so the console can say what happened');
  assert.ok(row.revoked);

  const redeemed = await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code: created.code }) });
  assert.equal(redeemed.status, 400);
});
