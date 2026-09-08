import test from 'node:test';
import assert from 'node:assert/strict';
import { findDate } from '../server/dates.js';

// A Tuesday, so weekday arithmetic has somewhere real to start from.
const TUE = '2026-09-08';

test('the example this was built for', () => {
  assert.equal(findDate('baterie pentru Luca mâine dimineața', TUE), '2026-09-09');
});

test('diacritics are optional, because nobody types them on a phone', () => {
  assert.equal(findDate('maine', TUE), '2026-09-09');
  assert.equal(findDate('mâine', TUE), '2026-09-09');
  assert.equal(findDate('poimaine', TUE), '2026-09-10');
  assert.equal(findDate('răspoimâine', TUE), '2026-09-11');
});

test('longer words win over the shorter ones inside them', () => {
  // "poimaine" contains "maine"; matching the short one first would make every
  // day after tomorrow tomorrow.
  assert.equal(findDate('poimâine', TUE), '2026-09-10');
  assert.notEqual(findDate('poimâine', TUE), findDate('mâine', TUE));
});

test('a weekday means the next one still to come', () => {
  assert.equal(findDate('vineri la 5', TUE), '2026-09-11', 'Tuesday to Friday');
  assert.equal(findDate('luni', TUE), '2026-09-14', 'the Monday after, not the one gone');
});

test('naming today\'s own weekday means a week today', () => {
  // Written on a Tuesday, "marți" is the Tuesday still to come.
  assert.equal(findDate('marți', TUE), '2026-09-15');
});

test('counted days', () => {
  assert.equal(findDate('în 3 zile', TUE), '2026-09-11');
  assert.equal(findDate('peste 10 zile', TUE), '2026-09-18');
  assert.equal(findDate('peste o săptămână', TUE), '2026-09-15');
  assert.equal(findDate('săptămâna viitoare', TUE), '2026-09-15');
});

test('dates written out', () => {
  assert.equal(findDate('pe 20 septembrie', TUE), '2026-09-20');
  assert.equal(findDate('12 oct 2026', TUE), '2026-10-12');
  assert.equal(findDate('20.09', TUE), '2026-09-20');
  assert.equal(findDate('20/09/2026', TUE), '2026-09-20');
  assert.equal(findDate('2026-11-03', TUE), '2026-11-03');
});

test('a bare day-and-month already gone means next year', () => {
  // Written in September, "12 ianuarie" is January coming, not eleven months
  // back down the calendar.
  assert.equal(findDate('12 ianuarie', TUE), '2027-01-12');
  // With the year spelled out, it is believed as written.
  assert.equal(findDate('12 ianuarie 2026', TUE), '2026-01-12');
});

test('the precise half of a sentence is the half to believe', () => {
  assert.equal(findDate('pe 20 septembrie, adică mâine', TUE), '2026-09-20');
});

test('"mai" on its own is never May', () => {
  // Far commoner as an ordinary word. Reading these as a month would be wrong
  // almost every time it fired.
  assert.equal(findDate('mai bine cumpăr una mai mare', TUE), null);
  assert.equal(findDate('mai vedem', TUE), null);
  // With a day in front of it, it is a date.
  assert.equal(findDate('14 mai', TUE), '2027-05-14');
});

test('looking backwards is not a deadline', () => {
  // A scrap recalling yesterday would otherwise arrive already overdue.
  assert.equal(findDate('ieri am uitat', TUE), null);
  assert.equal(findDate('alaltăieri', TUE), null);
});

test('a date that never happened is not returned', () => {
  assert.equal(findDate('31 februarie', TUE), null);
  assert.equal(findDate('32.13', TUE), null);
  assert.equal(findDate('2026-02-31', TUE), null);
});

test('ordinary notes get no date at all', () => {
  // The failure that matters: a wrong date sits there quietly being wrong,
  // where no date costs one tap.
  for (const note of [
    'baterie externă pentru Luca',
    'gând fără treabă în el',
    'am plătit 12 lei pe cafea',
    'suna la dentist',
    'ideea cu 3 straturi de vopsea',
    ''
  ]) {
    assert.equal(findDate(note, TUE), null, `no date in: ${note}`);
  }
});

test('nonsense in, null out', () => {
  assert.equal(findDate(null, TUE), null);
  assert.equal(findDate('mâine', 'not-a-day'), null);
  assert.equal(findDate('mâine', null), null);
});
