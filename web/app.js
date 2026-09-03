import { installUpdates } from '/pwa-update.js';

const $ = (id) => document.getElementById(id);

const state = {
  scraps: [],
  total: 0,
  shot: null,      // { base64, mimeType, objectUrl }
  me: null
};

// ------------------------------------------------------------------- api

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ------------------------------------------------------------- screens

/**
 * Makes the Android back gesture close the top screen instead of leaving.
 *
 * Every overlay pushes a history entry; the browser's back navigation is what
 * closes it. Dismiss buttons unwind history rather than hiding directly, so
 * there is one path in and one path out.
 */
const screens = [];

function openScreen(name, close) {
  screens.push({ name, close });
  history.pushState({ magpieScreen: name, depth: screens.length }, '');
}

function dismissScreen(name) {
  const i = screens.findIndex((s) => s.name === name && !s.dismissing);
  if (i === -1) return;
  for (let k = i; k < screens.length; k++) screens[k].dismissing = true;
  history.go(-(screens.length - i));
}

window.addEventListener('popstate', () => {
  const depth = history.state?.depth || 0;
  while (screens.length > depth) {
    const screen = screens.pop();
    try { screen.close(); } catch (err) { console.error('close failed', screen.name, err); }
  }
});

// -------------------------------------------------------------- capture

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

$('add-photo').addEventListener('click', () => $('file').click());

$('file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  try {
    if (state.shot?.objectUrl) URL.revokeObjectURL(state.shot.objectUrl);
    const objectUrl = URL.createObjectURL(file);
    state.shot = { base64: await readFile(file), mimeType: file.type || 'image/jpeg', objectUrl };
    $('shot-img').src = objectUrl;
    $('shot-preview').hidden = false;
  } catch (err) {
    toast(err.message);
  }
});

$('shot-drop').addEventListener('click', clearShot);

function clearShot() {
  if (state.shot?.objectUrl) URL.revokeObjectURL(state.shot.objectUrl);
  state.shot = null;
  $('shot-img').removeAttribute('src');
  $('shot-preview').hidden = true;
}

async function keep() {
  const body = $('scrap').value.trim();
  if (!body && !state.shot) return toast('Nothing to keep yet.');

  $('keep').disabled = true;
  try {
    const scrap = await api('/api/scraps', {
      method: 'POST',
      body: JSON.stringify({
        body,
        image: state.shot?.base64 || null,
        mimeType: state.shot?.mimeType || null
      })
    });
    // Cleared only once it is actually saved. Losing a thought to a failed
    // request would break the one promise the app makes.
    $('scrap').value = '';
    clearShot();
    state.scraps.unshift(scrap);
    state.total += 1;
    renderScraps();
    toast('Kept');
  } catch (err) {
    toast(err.message);
  } finally {
    $('keep').disabled = false;
  }
}

$('keep').addEventListener('click', keep);

// Ctrl/Cmd+Enter keeps it, for anyone typing at a keyboard.
$('scrap').addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); keep(); }
});

// --------------------------------------------------------------- scraps

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function when(iso) {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function renderScraps() {
  const list = $('scraps');
  $('empty').hidden = state.scraps.length > 0;
  $('scrap-count').textContent = state.total ? `${state.total}` : '';
  $('more').hidden = state.scraps.length >= state.total;

  list.innerHTML = state.scraps.map((s) => `
    <li class="scrap" data-id="${esc(s.id)}">
      ${s.imageId ? `<img src="/api/images/${encodeURIComponent(s.imageId)}" alt="" loading="lazy">` : ''}
      ${s.body ? `<div class="scrap-body">${esc(s.body)}</div>` : ''}
      <div class="scrap-meta">
        <span>${esc(when(s.createdAt))}</span>
        <button class="scrap-del" type="button" data-del="${esc(s.id)}" aria-label="Delete this scrap">&times;</button>
      </div>
    </li>`).join('');
}

$('scraps').addEventListener('click', async (ev) => {
  const id = ev.target.closest('[data-del]')?.dataset.del;
  if (!id) return;
  if (!confirm('Delete this scrap? It is not recoverable.')) return;
  try {
    await api(`/api/scraps/${id}`, { method: 'DELETE' });
    state.scraps = state.scraps.filter((s) => s.id !== id);
    state.total -= 1;
    renderScraps();
  } catch (err) {
    toast(err.message);
  }
});

$('more').addEventListener('click', async () => {
  const oldest = state.scraps[state.scraps.length - 1];
  if (!oldest) return;
  try {
    const data = await api(`/api/scraps?before=${encodeURIComponent(oldest.createdAt)}`);
    state.scraps.push(...data.scraps);
    state.total = data.total;
    renderScraps();
  } catch (err) {
    toast(err.message);
  }
});

async function loadScraps() {
  const data = await api('/api/scraps');
  state.scraps = data.scraps;
  state.total = data.total;
  renderScraps();
}

// -------------------------------------------------------------- settings

$('open-settings').addEventListener('click', async () => {
  $('settings').hidden = false;
  openScreen('settings', () => { $('settings').hidden = true; $('link-out').hidden = true; });
  await renderDevices();
});

$('settings-close').addEventListener('click', () => dismissScreen('settings'));

async function renderDevices() {
  try {
    const me = await api('/api/me');
    state.me = me;
    $('devices').innerHTML = me.devices.map((d) => `
      <li class="device">
        <span class="device-name">${esc(d.label || 'Unnamed device')}</span>
        ${d.id === me.deviceId ? '<span class="device-this">this one</span>' : ''}
        <span class="device-when">${d.last_seen ? esc(when(d.last_seen)) : 'not used yet'}</span>
      </li>`).join('');
  } catch (err) {
    toast(err.message);
  }
}

$('link-device').addEventListener('click', async () => {
  try {
    const { code } = await api('/api/devices/link-code', { method: 'POST' });
    $('link-code').textContent = code;
    $('link-out').hidden = false;
  } catch (err) {
    toast(err.message);
  }
});

$('new-recovery').addEventListener('click', async () => {
  if (!confirm('Replace your recovery code? The old one stops working immediately.')) return;
  try {
    const { recoveryCode } = await api('/api/devices/recovery', { method: 'POST' });
    showRecovery(recoveryCode);
  } catch (err) {
    toast(err.message);
  }
});

// -------------------------------------------------------------- recovery

function showRecovery(code) {
  $('recovery-code').textContent = code;
  $('recovery').hidden = false;
}

$('recovery-copy').addEventListener('click', async () => {
  const text = $('recovery-code').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    // No clipboard API outside a secure context; select it instead so it can
    // be copied by hand.
    const range = document.createRange();
    range.selectNodeContents($('recovery-code'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    toast('Select and copy');
  }
});

$('recovery-done').addEventListener('click', () => { $('recovery').hidden = true; });

// ------------------------------------------------------------------ gate

let gateMode = 'invite';
const GATE_COPY = {
  invite:  { label: 'Invite code',   hint: 'The code you were sent.',                       ph: 'ABCDE-FGHJK' },
  link:    { label: 'Link code',     hint: 'Made under Settings on a device already in.',   ph: 'ABCDE-FGHJK' },
  recover: { label: 'Recovery code', hint: 'The code you wrote down when you first joined.', ph: 'ABCDE-FGHJKLM' }
};

document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    gateMode = btn.dataset.mode;
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('is-on', b === btn));
    const copy = GATE_COPY[gateMode];
    $('gate-label').textContent = copy.label;
    $('gate-hint').textContent = copy.hint;
    $('gate-code').placeholder = copy.ph;
    $('gate-error').hidden = true;
  });
});

$('gate-go').addEventListener('click', async () => {
  const code = $('gate-code').value.trim().toUpperCase();
  if (!code) return;

  const path = gateMode === 'invite' ? '/api/auth/redeem'
    : gateMode === 'link' ? '/api/auth/link'
    : '/api/auth/recover';

  $('gate-go').disabled = true;
  $('gate-error').hidden = true;
  try {
    const data = await api(path, {
      method: 'POST',
      body: JSON.stringify({ code, label: navigator.userAgent.includes('Android') ? 'Android' : 'Device' })
    });
    $('gate').hidden = true;
    $('app').hidden = false;
    if (data.recoveryCode) showRecovery(data.recoveryCode);
    await loadScraps();
  } catch (err) {
    $('gate-error').textContent = err.message;
    $('gate-error').hidden = false;
  } finally {
    $('gate-go').disabled = false;
  }
});

$('gate-code').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); $('gate-go').click(); }
});

// ------------------------------------------------------------------ boot

(async function boot() {
  try {
    await api('/api/me');
    $('app').hidden = false;
    await loadScraps();
  } catch {
    $('gate').hidden = false;
    // An invite link fills the code in, so the only thing left is to press it.
    const invited = new URLSearchParams(location.search).get('invite');
    if (invited) {
      $('gate-code').value = invited.toUpperCase();
      $('gate-hint').textContent = 'Code filled in from your link — press Continue.';
      history.replaceState(history.state, '', location.pathname);
    }
  }
})();

installUpdates({
  appName: 'Magpie',
  toast: (message) => toast(message),
  // A thought half-typed is unsaved work, and reloading through it would lose
  // exactly the thing this app promises to keep.
  isBusy: () => Boolean($('scrap').value.trim() || state.shot)
});
