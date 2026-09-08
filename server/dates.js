/**
 * Magpie — the date that was already in the sentence.
 *
 * "Baterie externă pentru Luca mâine dimineața" has a date in it. Asking for
 * one afterwards, in a picker, is asking someone to type a thing they have
 * just typed.
 *
 * This is not Magpie having an opinion. It reads a word the person wrote and
 * takes it at face value; it never decides that something is a task, never
 * rewrites the body, and never invents a date that is not spelled out. That
 * line matters, because the moment the pile starts guessing at deadlines it
 * has begun handing out homework.
 *
 * Conservative on purpose. A wrong date is worse than no date: no date costs
 * one tap, a wrong one sits there quietly being wrong until it is noticed. So
 * anything ambiguous is left alone -- see the notes on "mai" and on bare day
 * numbers, both of which are commoner as ordinary words than as dates.
 */

/** Diacritics off, so "mâine" and "maine" are the same word. */
function plain(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[ăâà]/g, 'a')
    .replace(/[îí]/g, 'i')
    .replace(/[șş]/g, 's')
    .replace(/[țţ]/g, 't')
    .replace(/é/g, 'e');
}

const MONTHS = {
  ianuarie: 1, ian: 1,
  februarie: 2, feb: 2,
  martie: 3, mar: 3,
  aprilie: 4, apr: 4,
  // "mai" is only ever read as a month with a day number in front of it. On
  // its own it is one of the commonest words in Romanian -- "mai bine", "mai
  // mult" -- and reading those as May would be wrong far more often than right.
  mai: 5,
  iunie: 6, iun: 6,
  iulie: 7, iul: 7,
  august: 8, aug: 8,
  septembrie: 9, sept: 9, sep: 9,
  octombrie: 10, oct: 10,
  noiembrie: 11, noi: 11,
  decembrie: 12, dec: 12
};

/** duminică is 0, to line up with getUTCDay. */
const WEEKDAYS = {
  duminica: 0, luni: 1, marti: 2, miercuri: 3, joi: 4, vineri: 5, sambata: 6
};

const iso = (d) => d.toISOString().slice(0, 10);
const dayOf = (ymd) => new Date(`${ymd}T00:00:00Z`);
const shift = (ymd, days) => {
  const d = dayOf(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};

/** Real dates only: this is what rejects 31 February before it is stored. */
function build(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ymd = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const d = dayOf(ymd);
  return !Number.isNaN(d.getTime()) && iso(d) === ymd ? ymd : null;
}

/**
 * The date a scrap mentions, or null.
 *
 * `today` is the client's local calendar day, because "mâine" is tomorrow
 * where the person is standing and nowhere else.
 *
 * Explicit dates win over relative words: a scrap saying "pe 12 septembrie,
 * adică mâine" is being precise once and loose once, and the precise half is
 * the one to believe.
 */
export function findDate(text, today) {
  const s = plain(text);
  if (!s.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return null;

  return explicit(s, today) ?? relative(s, today);
}

function explicit(s, today) {
  const thisYear = dayOf(today).getUTCFullYear();

  // 2026-09-20
  const isoMatch = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const built = build(+isoMatch[1], +isoMatch[2], +isoMatch[3]);
    if (built) return built;
  }

  // 12 septembrie, 12 sept 2026
  const named = s.match(/\b(\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{4}))?\b/);
  if (named && MONTHS[named[2]]) {
    const year = named[3] ? +named[3] : thisYear;
    const built = build(year, MONTHS[named[2]], +named[1]);
    // Without a year, a date already gone means next year -- "12 ianuarie"
    // written in December is not eleven months ago.
    if (built) return !named[3] && built < today ? build(year + 1, MONTHS[named[2]], +named[1]) : built;
  }

  // 12.09, 12/09/2026. Day first, which is how it is written here.
  const numeric = s.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/);
  if (numeric) {
    const year = numeric[3]
      ? (numeric[3].length === 2 ? 2000 + +numeric[3] : +numeric[3])
      : thisYear;
    const built = build(year, +numeric[2], +numeric[1]);
    if (built) return !numeric[3] && built < today ? build(year + 1, +numeric[2], +numeric[1]) : built;
  }

  return null;
}

function relative(s, today) {
  // Longest first: "poimaine" contains "maine", and "raspoimaine" contains both.
  if (/\braspoimaine\b/.test(s)) return shift(today, 3);
  if (/\bpoimaine\b/.test(s)) return shift(today, 2);
  if (/\bmaine\b/.test(s)) return shift(today, 1);
  if (/\b(azi|astazi)\b/.test(s)) return today;

  // Deliberately no "ieri" or "alaltaieri". Those look backwards, and a scrap
  // recalling yesterday is not a task due then -- it would simply arrive
  // already overdue, which is a worse answer than no date at all.

  const inDays = s.match(/\b(?:in|peste)\s+(\d{1,3})\s+zile\b/);
  if (inDays) {
    const n = +inDays[1];
    if (n >= 1 && n <= 365) return shift(today, n);
  }
  if (/\b(?:in|peste)\s+o\s+saptamana\b/.test(s)) return shift(today, 7);
  if (/\bsaptamana\s+viitoare\b/.test(s)) return shift(today, 7);

  // A weekday means the next one that has not happened yet. Naming today's own
  // weekday means a week today: someone writing "vineri" on a Friday is
  // talking about the Friday still to come.
  for (const [word, wanted] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`\\b${word}\\b`).test(s)) continue;
    const current = dayOf(today).getUTCDay();
    const ahead = (wanted - current + 7) % 7;
    return shift(today, ahead === 0 ? 7 : ahead);
  }

  return null;
}
