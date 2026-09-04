import { installUpdates } from '/pwa-update.js';

const $ = (id) => document.getElementById(id);

const state = {
  scraps: [],
  total: 0,
  shot: null,      // { base64, mimeType, objectUrl }
  audioId: null,   // set once a recording has been transcribed
  lastCollision: null,
  me: null,
  autoEcho: true,        // overwritten by /api/me on boot
  pendingEcho: new Set() // ids with a remark in flight, so the card shows neither
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

/**
 * Let the box go when the app comes back.
 *
 * An installed app is resumed far more often than it is loaded, and a resume
 * is not a reload: the page is exactly as it was left, focus included. Leaving
 * it after saving a scrap is right at the time -- you are mid-flow -- but it
 * means the keyboard springs up the next time the app is opened, hours later,
 * which is the thing that was asked to stop.
 *
 * Only when the box is empty. Half a sentence left in there means you were in
 * the middle of something and coming back to finish it.
 */
function releaseBoxOnReturn() {
  if (document.visibilityState !== 'visible') return;
  const box = $('scrap');
  if (document.activeElement !== box) return;
  if (box.value.trim()) return;
  box.blur();
}

document.addEventListener('visibilitychange', releaseBoxOnReturn);
// Coming back from the back/forward cache does not fire visibilitychange.
window.addEventListener('pageshow', releaseBoxOnReturn);

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
    $('shot-read').hidden = true;
    readShotText();
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
 * Runs by itself the moment a picture is attached. It was a button on the
 * grounds that reading a picture means sending it away -- but the picture is
 * already sent, automatically, so Magpie can say something about it. Making
 * the reading a separate decision protected nothing and cost a tap on the one
 * capture that exists to avoid typing.
 *
 * Silent when there is nothing to read. Most photographs are not of text, and
 * saying so every time would be a notification about the ordinary case.
 */
async function readShotText({ manual = false } = {}) {
  if (!state.shot || state.shot.read) return;
  const btn = $('shot-read');
  btn.hidden = false;
  btn.disabled = true;
  btn.textContent = 'Citesc…';
  try {
    const { text } = await api('/api/photo/read', {
      method: 'POST',
      body: JSON.stringify({ image: state.shot.base64, mimeType: state.shot.mimeType })
    });
    if (!state.shot) return;              // dropped while it was being read
    state.shot.read = true;
    if (!text) {
      // Nothing there. Leave the retry for anyone who thinks otherwise.
      btn.hidden = !manual;
      btn.textContent = 'Citește textul';
      btn.disabled = false;
      if (manual) toast('N-am găsit text în poză.');
      return;
    }
    const box = $('scrap');
    box.value = box.value.trim() ? `${box.value.trim()}\n${text}` : text;
    autoGrow();
    tick();
    btn.hidden = true;
  } catch (err) {
    // Kept quiet unless asked: the photo is saved either way, and a failed
    // reading is not a lost thought.
    state.shot.read = false;
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Citește textul';
    if (manual) toast(err.message);
  }
}

$('shot-read').addEventListener('click', () => readShotText({ manual: true }));

function clearShot() {
  if (state.shot?.objectUrl) URL.revokeObjectURL(state.shot.objectUrl);
  state.shot = null;
  $('shot-read').hidden = true;
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

    // Marked as pending before the first render rather than inside askEcho, so
    // the fresh card never flashes an ask button for the second or two it
    // takes the remark to come back.
    const willAsk = state.autoEcho && Boolean(scrap.body || scrap.imageId);
    if (willAsk) state.pendingEcho.add(scrap.id);

    renderScraps({ toBottom: true });
    autoGrow();
    tick();
    // Kept deliberately, unlike focus on arrival: you were already typing with
    // the keyboard up, so a second thought should not need a second reach. The
    // app opening is the opposite case -- it is often opened to read, and a
    // keyboard covering half the screen to do that is hostile.
    $('scrap').focus();
    // Asked for only after the scrap is safely kept, so a slow or absent model
    // costs a remark and never a thought.
    if (willAsk) askEcho(scrap.id);
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

/**
 * Ask for the one short thing said back.
 *
 * Called on its own after a save when Magpie is set to speak first, and from
 * the button on a card otherwise. The route is the same either way and answers
 * with an existing remark rather than a second one, so pressing the button on
 * a card that already has one costs nothing.
 */
async function askEcho(id) {
  state.pendingEcho.add(id);
  try {
    const { echo } = await api(`/api/scraps/${id}/echo`, { method: 'POST' });
    const scrap = state.scraps.find((s) => s.id === id);
    if (scrap && echo) scrap.echo = echo;
  } catch {
    // Magpie having nothing to say is not an error worth showing anyone.
  } finally {
    // Rendered here rather than only on success, so a card whose remark never
    // arrived gets its button back instead of going quiet for good.
    state.pendingEcho.delete(id);
    renderScraps();
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
  $('collide-label').textContent = 'Ciocnesc…';
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
    $('collide-label').textContent = 'Ciocnește două';
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

/**
 * What sits under a card: the remark, or the way to ask for one.
 *
 * The button is offered whenever a card has none and nothing is in flight for
 * it -- which covers both halves of the setting. With Magpie speaking first it
 * appears only where a remark failed to arrive, and is a retry; with her quiet
 * it is the whole of how she is asked.
 */
function echoSlot(s) {
  if (s.echo) return `<p class="scrap-echo">${esc(s.echo)}</p>`;
  if (state.pendingEcho.has(s.id)) return '<p class="scrap-echo is-waiting">se gândește…</p>';
  if (!s.body && !s.imageId) return '';
  return `<button class="scrap-ask" type="button" data-ask="${esc(s.id)}">Ce zici?</button>`;
}

function renderScraps({ toBottom = false } = {}) {
  const list = $('scraps');
  $('empty').hidden = state.scraps.length > 0;
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
      ${echoSlot(s)}
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
  const ask = ev.target.closest('[data-ask]');
  if (ask) {
    // Swapped in place rather than through a re-render: rewriting the list
    // would stop any recording being played further up it.
    ask.disabled = true;
    ask.textContent = 'se gândește…';
    return askEcho(ask.dataset.ask);
  }

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
}

// -------------------------------------------------------------- settings

$('open-settings').addEventListener('click', async () => {
  $('settings').hidden = false;
  openScreen('settings', () => { $('settings').hidden = true; $('link-out').hidden = true; });
  await Promise.all([renderDevices(), renderStats()]);
});

$('settings-close').addEventListener('click', () => dismissScreen('settings'));

async function renderDevices() {
  try {
    const me = await api('/api/me');
    state.me = me;
    state.autoEcho = me.autoEcho !== false;
    $('auto-echo').checked = state.autoEcho;
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

/**
 * Whether Magpie speaks first.
 *
 * Flipped optimistically and put back if the server refuses, because a switch
 * that waits for a round trip before moving feels broken on a slow phone. The
 * cost of being wrong here is one wrong-looking switch for half a second.
 */
$('auto-echo').addEventListener('change', async (ev) => {
  const wanted = ev.target.checked;
  state.autoEcho = wanted;
  try {
    await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ autoEcho: wanted })
    });
    toast(wanted ? 'Magpie răspunde singură' : 'Magpie tace până o întrebi');
  } catch (err) {
    state.autoEcho = !wanted;
    ev.target.checked = !wanted;
    toast(err.message);
  }
  // Cards that had no remark gain or lose their button with the setting.
  renderScraps();
});

/**
 * What the pile adds up to.
 *
 * Written to describe, never to grade. No streak, no average presented as a
 * quota, no empty day called out -- a scratchpad that can be failed stops
 * being a place you throw things without thinking, which is the only thing
 * this app is for.
 *
 * The bars carry no numbers on purpose: the shape of a fortnight is the
 * interesting part, and a figure over each column would invite comparing them.
 */
async function renderStats() {
  const box = $('stats');
  if (!box) return;
  try {
    const tz = -new Date().getTimezoneOffset();
    const s = await api(`/api/stats?tz=${tz}`);

    if (!s.total) {
      box.innerHTML = '<p class="hint">Încă nimic de numărat.</p>';
      return;
    }

    const peak = Math.max(...s.byDay.map((d) => d.n), 1);
    const bars = s.byDay.map((d) => `<div class="bar-col" title="${esc(d.day)}: ${d.n}">
      <div class="bar" style="height:${d.n ? Math.max(8, (d.n / peak) * 100) : 2}%"></div>
    </div>`).join('');

    const hourPeak = Math.max(...s.byHour, 1);
    const hours = s.byHour.map((n, h) => `<div class="hour" title="${h}:00 — ${n}"
      style="height:${n ? Math.max(10, (n / hourPeak) * 100) : 2}%"></div>`).join('');

    box.innerHTML = `
      <div class="stat-grid">
        ${stat(s.total, s.total === 1 ? 'fragment' : 'fragmente')}
        ${stat(s.days, s.days === 1 ? 'zi cu ceva în ea' : 'zile cu ceva în ele')}
        ${stat(s.kinds.text, 'scrise')}
        ${stat(s.kinds.photo, s.kinds.photo === 1 ? 'poză' : 'poze')}
        ${stat(s.kinds.voice, s.kinds.voice === 1 ? 'înregistrare' : 'înregistrări')}
        ${stat(s.echoes + s.collisions, 'zise de Magpie')}
      </div>

      <p class="stat-cap">Ultimele două săptămâni</p>
      <div class="bars">${bars}</div>
      <div class="hours-scale"><span>acum două săptămâni</span><span>azi</span></div>

      <p class="stat-cap">La ce oră îți vin</p>
      <div class="hours">${hours}</div>
      <div class="hours-scale"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>

      <p class="hint">${esc(sinceLine(s.firstAt))}</p>`;
  } catch (err) {
    box.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
}

function stat(value, label) {
  return `<div class="stat"><span class="stat-n">${value}</span><span class="stat-l">${esc(label)}</span></div>`;
}

/**
 * How long this has been going, said plainly.
 *
 * A date rather than a countdown: "de 34 de zile" reads as something being
 * measured, and the point is that nothing here is.
 */
function sinceLine(firstAt) {
  if (!firstAt) return '';
  const first = new Date(firstAt);
  return `Primul, ${first.toLocaleDateString('ro-RO', { day: 'numeric', month: 'long', year: 'numeric' })}.`;
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
    const me = await api('/api/me');
    state.me = me;
    state.autoEcho = me.autoEcho !== false;
    $('auto-echo').checked = state.autoEcho;
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
