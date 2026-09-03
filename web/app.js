import { installUpdates } from '/pwa-update.js';

const $ = (id) => document.getElementById(id);

const state = {
  scraps: [],
  total: 0,
  shot: null,      // { base64, mimeType, objectUrl }
  audioId: null,   // set once a recording has been transcribed
  lastCollision: null,
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
    const err = new Error(data.message || `Cererea a eșuat (${res.status})`);
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
  // Let the keyboard go. The box keeps focus when something opens over it,
  // and on a phone that means the keyboard stays up covering the screen just
  // opened.
  document.activeElement?.blur?.();
  screens.push({ name, close });
  history.pushState({ magpieScreen: name, depth: screens.length }, '');
}

function dismissScreen(name) {
  const i = screens.findIndex((s) => s.name === name && !s.dismissing);
  if (i === -1) return;
  for (let k = i; k < screens.length; k++) screens[k].dismissing = true;
  history.go(-(screens.length - i));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') focusBox();
});

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
    reader.onerror = () => reject(new Error('N-am putut citi fișierul.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Camera or gallery, asked rather than guessed.
 *
 * The two are the same file input with and without `capture`, but they are
 * different intentions: photographing a whiteboard in front of you, versus
 * fishing out something already on the phone. One button that silently picks
 * one of them is wrong half the time.
 *
 * A small menu rather than a third round button, because four buttons and a
 * text box in one row leaves the box too narrow to type in on a small phone.
 */
function togglePhotoMenu(open) {
  const menu = $('photo-menu');
  const show = open ?? menu.hidden;
  menu.hidden = !show;
  $('add-photo').setAttribute('aria-expanded', String(show));
}

$('add-photo').addEventListener('click', (ev) => {
  ev.stopPropagation();
  togglePhotoMenu();
});

$('do-camera').addEventListener('click', () => { togglePhotoMenu(false); $('file-camera').click(); });
$('do-pick').addEventListener('click', () => { togglePhotoMenu(false); $('file-pick').click(); });

// Anywhere else, or Escape, closes it.
document.addEventListener('click', () => togglePhotoMenu(false));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') togglePhotoMenu(false);
});

const onPicked = async (ev) => {
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
};

$('file-camera').addEventListener('change', onPicked);
$('file-pick').addEventListener('change', onPicked);

$('shot-drop').addEventListener('click', clearShot);

/**
 * Lift the words off a photographed board or page.
 *
 * Offered rather than automatic: reading a picture means sending it away, and
 * that should be something you press, not something that happens to every
 * photo you attach. The text lands in the box beside the picture, which is
 * kept either way.
 */
$('shot-read').addEventListener('click', async () => {
  if (!state.shot) return;
  const btn = $('shot-read');
  btn.disabled = true;
  btn.textContent = 'Citesc…';
  try {
    const { text } = await api('/api/photo/read', {
      method: 'POST',
      body: JSON.stringify({ image: state.shot.base64, mimeType: state.shot.mimeType })
    });
    if (!text) { toast('N-am găsit text în poză.'); return; }
    const box = $('scrap');
    box.value = box.value.trim() ? `${box.value.trim()}\n${text}` : text;
    autoGrow();
    box.focus();
    tick();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Citește textul';
  }
});

function clearShot() {
  if (state.shot?.objectUrl) URL.revokeObjectURL(state.shot.objectUrl);
  state.shot = null;
  $('shot-img').removeAttribute('src');
  $('shot-preview').hidden = true;
}

async function keep() {
  const body = $('scrap').value.trim();
  if (!body && !state.shot) return toast('N-ai scris nimic încă.');

  $('keep').disabled = true;
  try {
    const scrap = await api('/api/scraps', {
      method: 'POST',
      body: JSON.stringify({
        body,
        image: state.shot?.base64 || null,
        mimeType: state.shot?.mimeType || null,
        audioId: state.audioId || null
      })
    });
    // Cleared only once it is actually saved. Losing a thought to a failed
    // request would break the one promise the app makes.
    $('scrap').value = '';
    state.audioId = null;
    clearShot();
    state.scraps.unshift(scrap);
    state.total += 1;
    renderScraps({ toBottom: true });
    autoGrow();
    tick();
    // Straight on to the next one without reaching for the field again.
    $('scrap').focus();
    // Asked for after the scrap is safely kept, so a slow or absent model
    // costs a remark and never a thought.
    if (scrap.body || scrap.imageId) askEcho(scrap.id);
    syncCollide();
  } catch (err) {
    toast(err.message);
  } finally {
    $('keep').disabled = false;
  }
}

$('keep').addEventListener('click', keep);

/**
 * A short haptic on save.
 *
 * The point is that offloading should feel like something. Most of the cost of
 * writing a thought down is the friction before it, and a small physical
 * acknowledgement is the cheapest way to lower that.
 */
function tick() {
  try { navigator.vibrate?.(12); } catch { /* not supported, no matter */ }
}

async function askEcho(id) {
  try {
    const { echo } = await api(`/api/scraps/${id}/echo`, { method: 'POST' });
    const scrap = state.scraps.find((s) => s.id === id);
    if (!scrap || !echo) return;
    scrap.echo = echo;
    renderScraps();
  } catch {
    // Magpie having nothing to say is not an error worth showing anyone.
  }
}

// ----------------------------------------------------------------- voice

/**
 * Say it instead of typing it.
 *
 * The reason this matters more than it looks: by the time you unlock a phone,
 * find the app and type three words, the thought you were chasing has often
 * gone. Speaking it costs almost nothing and catches it while it is still
 * there.
 *
 * The recording is kept. What comes back is a transcript dropped into the box
 * for you to look at before keeping -- Magpie's reading of what you said, not
 * a replacement for it.
 */
let recorder = null;
let recChunks = [];
let recStarted = 0;
let recTimer = null;

async function startTalking() {
  if (recorder) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return toast('N-am acces la microfon.');
  }

  // webm/opus everywhere except Safari, which wants mp4.
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    .find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  recChunks = [];
  recorder.ondataavailable = (ev) => { if (ev.data.size) recChunks.push(ev.data); };
  recorder.onstop = () => finishTalking(stream, recorder.mimeType || type || 'audio/webm');
  recorder.start();

  recStarted = Date.now();
  $('rec-bar').hidden = false;
  $('hold-talk').disabled = true;
  tick();
  recTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - recStarted) / 1000);
    $('rec-time').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    // Nobody means to leave it running for five minutes.
    if (secs >= 300) stopTalking();
  }, 250);
}

function stopTalking() {
  if (!recorder || recorder.state === 'inactive') return;
  recorder.stop();
}

async function finishTalking(stream, mimeType) {
  clearInterval(recTimer);
  stream.getTracks().forEach((t) => t.stop());
  recorder = null;
  $('rec-bar').hidden = true;
  $('rec-time').textContent = '0:00';
  $('hold-talk').disabled = false;

  const blob = new Blob(recChunks, { type: mimeType });
  if (blob.size < 1200) return;   // a tap rather than a thought

  toast('Ascult…');
  try {
    const reader = new FileReader();
    const base64 = await new Promise((ok, no) => {
      reader.onload = () => ok(String(reader.result).split(',')[1]);
      reader.onerror = () => no(new Error('N-am putut citi înregistrarea.'));
      reader.readAsDataURL(blob);
    });

    const heard = await api('/api/voice', {
      method: 'POST',
      body: JSON.stringify({ audio: base64, mimeType })
    });
    state.audioId = heard.audioId;
    const box = $('scrap');
    box.value = box.value ? `${box.value.trim()}\n${heard.text}` : heard.text;
    autoGrow();
    box.focus();
    tick();
  } catch (err) {
    toast(err.message);
  }
}

$('hold-talk').addEventListener('click', startTalking);
$('rec-stop').addEventListener('click', stopTalking);

// --------------------------------------------------------------- collide

/**
 * Two scraps knocked together.
 *
 * Offered from the second scrap onward, which is the point of it: clustering
 * needs dozens before it can say anything true, and this needs a pair. It is
 * also the only part of the app that is purely for fun, which on balance is
 * what makes the pile feel like a toy rather than a filing cabinet.
 */
function syncCollide() {
  $('collide-wrap').hidden = state.total < 2;
}

async function runCollide() {
  $('collide-go').disabled = true;
  $('collide-go').textContent = 'Ciocnesc…';
  try {
    const out = await api('/api/collide', { method: 'POST' });
    $('collide-said').textContent = out.body;
    $('collide-from').textContent = `${trim(out.a.body)}  ×  ${trim(out.b.body)}`;
    $('collide-out').hidden = false;
    state.lastCollision = out.body;
    tick();
  } catch (err) {
    toast(err.message);
  } finally {
    $('collide-go').disabled = false;
    $('collide-go').textContent = 'Ciocnește două';
  }
}

const trim = (t) => (t.length > 38 ? `${t.slice(0, 38)}…` : t);

$('collide-go').addEventListener('click', runCollide);
$('collide-again').addEventListener('click', runCollide);

// Keeping one makes it a scrap of its own, which is the honest thing: it came
// out of the machine, and once it is in the pile it is treated like anything
// else thrown in.
$('collide-keep').addEventListener('click', async () => {
  if (!state.lastCollision) return;
  $('scrap').value = state.lastCollision;
  $('collide-out').hidden = true;
  autoGrow();
  $('scrap').focus();
});

// ---------------------------------------------------------------- sparks

/**
 * Something to push against when the box is empty.
 *
 * Asked what they are thinking, plenty of people go blank -- the blank box is
 * its own kind of friction. These are deliberately odd rather than useful, and
 * they never nag: shown quietly, gone the moment anything is typed.
 */
const SPARKS = [
  'cel mai ciudat lucru pe care l-ai văzut azi',
  'ceva care te enervează și pe nimeni altcineva',
  'un lucru pe care l-ai construi dacă ar fi ușor',
  'o părere pe care n-ai spus-o cu voce tare',
  'ceva ce tot zici că o să cauți',
  'cea mai proastă idee a ta din săptămâna asta',
  'un lucru care ar fi mai bun dacă ar fi mai mare',
  'ceva ce ai observat la o piesă',
  'o întrebare la care nu știi răspunsul',
  'un lucru care ar trebui să existe și nu există'
];

function showSpark() {
  if ($('scrap').value.trim()) return ($('spark').hidden = true);
  $('spark').textContent = SPARKS[Math.floor(Math.random() * SPARKS.length)];
  $('spark').hidden = false;
}

/**
 * Put the cursor in the box the moment there is a box.
 *
 * The app is opened to throw something in, so the thing you came to do should
 * be one keystroke away rather than one tap and then a keystroke.
 *
 * On a phone this focuses the field but does not necessarily raise the
 * keyboard: browsers only open it in response to a real touch, and nothing can
 * be done about that from script. Focusing is still worth it -- the caret is
 * already where it needs to be, and tapping anywhere in the field types rather
 * than aims.
 *
 * Refuses when something is on top or there is already text, so returning to
 * the app in the middle of something never yanks the view around.
 */
function focusBox() {
  if (screens.length) return;
  if ($('app').hidden) return;
  const box = $('scrap');
  if (document.activeElement === box) return;
  try { box.focus({ preventScroll: true }); } catch { box.focus(); }
}

function autoGrow() {
  const box = $('scrap');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, window.innerHeight * 0.4)}px`;
}

$('scrap').addEventListener('input', () => {
  $('spark').hidden = Boolean($('scrap').value.trim());
  autoGrow();
});

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
  if (mins < 1) return 'chiar acum';
  if (mins < 60) return `acum ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `acum ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `acum ${days} z`;
  return then.toLocaleDateString('ro-RO', { day: 'numeric', month: 'short' });
}

function renderScraps({ toBottom = false } = {}) {
  const list = $('scraps');
  $('empty').hidden = state.scraps.length > 0;
  $('foot-note').hidden = state.scraps.length === 0;
  $('scrap-count').textContent = state.total ? `${state.total}` : '';
  $('more').hidden = state.scraps.length >= state.total;

  // Held newest-first, shown oldest-first: the newest ends up against the
  // composer, where the eye already is and where the last thing you threw in
  // ought to be.
  list.innerHTML = [...state.scraps].reverse().map((s) => `
    <li class="scrap" data-id="${esc(s.id)}">
      ${s.imageId ? `<img src="/api/images/${encodeURIComponent(s.imageId)}" alt="" loading="lazy">` : ''}
      ${s.body ? `<div class="scrap-body">${esc(s.body)}</div>` : ''}
      ${s.audioId ? `<audio class="scrap-audio" controls preload="none" src="/api/audio/${encodeURIComponent(s.audioId)}"></audio>` : ''}
      ${s.echo ? `<p class="scrap-echo">${esc(s.echo)}</p>` : ''}
      <div class="scrap-meta">
        <span>${esc(when(s.createdAt))}</span>
        <button class="scrap-del" type="button" data-del="${esc(s.id)}" aria-label="Șterge fragmentul">&times;</button>
      </div>
    </li>`).join('');

  if (toBottom) scrollToBottom();
}

/**
 * Down to the newest.
 *
 * Called after a save and on first load rather than on every render, so
 * scrolling back through older scraps is not yanked away by a late echo
 * arriving for something further down.
 */
function scrollToBottom(smooth = false) {
  // After a frame, not immediately: the list has just been written into the
  // DOM and scrollHeight is still the old one until layout runs, so scrolling
  // now lands short of the bottom by however much was just added.
  requestAnimationFrame(() => {
    const stream = $('stream');
    stream.scrollTo({ top: stream.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  });
}

$('scraps').addEventListener('click', async (ev) => {
  const id = ev.target.closest('[data-del]')?.dataset.del;
  if (!id) return;
  if (!confirm('Ștergi fragmentul? Nu se mai poate recupera.')) return;
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
    const stream = $('stream');
    const before = stream.scrollHeight;
    state.scraps.push(...data.scraps);
    state.total = data.total;
    renderScraps();
    // Older ones are inserted above, so without this the page would appear to
    // jump backwards by exactly the height of what was just added.
    stream.scrollTop += stream.scrollHeight - before;
  } catch (err) {
    toast(err.message);
  }
});

async function loadScraps() {
  const data = await api('/api/scraps');
  state.scraps = data.scraps;
  state.total = data.total;
  renderScraps({ toBottom: true });
  syncCollide();
  showSpark();
  focusBox();
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
        <span class="device-name">${esc(d.label || 'Dispozitiv fără nume')}</span>
        ${d.id === me.deviceId ? '<span class="device-this">acesta</span>' : ''}
        <span class="device-when">${d.last_seen ? esc(when(d.last_seen)) : 'nefolosit încă'}</span>
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
  if (!confirm('Înlocuiești codul de recuperare? Cel vechi nu mai merge imediat.')) return;
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
    toast('Copiat');
  } catch {
    // No clipboard API outside a secure context; select it instead so it can
    // be copied by hand.
    const range = document.createRange();
    range.selectNodeContents($('recovery-code'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    toast('Selectează și copiază');
  }
});

$('recovery-done').addEventListener('click', () => { $('recovery').hidden = true; });

// ------------------------------------------------------------------ gate

let gateMode = 'invite';
const GATE_COPY = {
  invite:  { label: 'Cod de invitație',  hint: 'Codul pe care l-ai primit.',                          ph: 'ABCDE-FGHJK' },
  link:    { label: 'Cod de legare',     hint: 'Îl faci din Setări, pe un dispozitiv deja intrat.',   ph: 'ABCDE-FGHJK' },
  recover: { label: 'Cod de recuperare', hint: 'Codul pe care l-ai notat când ai intrat prima oară.', ph: 'ABCDE-FGHJKLM' }
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
      body: JSON.stringify({ code, label: navigator.userAgent.includes('Android') ? 'Android' : 'Dispozitiv' })
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
      $('gate-hint').textContent = 'Codul e completat din link — apasă Continuă.';
      history.replaceState(history.state, '', location.pathname);
    }
  }
})();

installUpdates({
  appName: 'Magpie',
  message: 'Magpie s-a actualizat la ultima versiune',
  toast: (message) => toast(message),
  // A thought half-typed is unsaved work, and reloading through it would lose
  // exactly the thing this app promises to keep.
  isBusy: () => Boolean($('scrap').value.trim() || state.shot)
});
