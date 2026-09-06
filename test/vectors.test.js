import test from 'node:test';
import assert from 'node:assert/strict';
import { pack, unpack } from '../server/vectors.js';

test('a vector survives the round trip through the blob', () => {
  const values = [0.5, -0.25, 0, 1, -1];
  const back = unpack(pack(values), values.length);
  assert.equal(back.length, values.length);
  values.forEach((v, i) => assert.ok(Math.abs(back[i] - v) < 1e-6, `dim ${i}`));
});

test('packing is float32, not JSON', () => {
  // 3072 dims is 12 KB packed and about 60 KB as text, and the whole pile is
  // read on every connections query. The size is the reason for the format.
  const values = new Array(3072).fill(0.1);
  assert.equal(pack(values).byteLength, 3072 * 4);
});

/**
 * Cosine is not exported -- it is an implementation detail of neighboursOf --
 * so it is restated here. The point of the test is the property, not the
 * function: near must mean near, and length must not matter.
 */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

test('identical directions score 1, opposite score -1, perpendicular score 0', () => {
  assert.ok(Math.abs(cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0, 0], [-1, 0, 0]) + 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0, 0], [0, 1, 0])) < 1e-9);
});

test('magnitude does not affect the score', () => {
  // A long scrap and a short one about the same thing must read as close. If
  // this ever became a dot product, length alone would decide the ranking.
  const short = [0.1, 0.2, 0.3];
  const long = [10, 20, 30];
  assert.ok(Math.abs(cosine(short, long) - 1) < 1e-9);
});

test('a zero vector scores zero rather than dividing by zero', () => {
  assert.equal(cosine([0, 0, 0], [1, 2, 3]), 0);
});

/**
 * Centring is the whole reason connections work, so the property it provides
 * is worth pinning: a shared component that says nothing about subject must
 * not be allowed to dominate the comparison.
 */
test('subtracting the common component separates what raw cosine cannot', () => {
  // Three vectors with a large shared component -- the stand-in for one
  // person's voice, language and preoccupations -- and a small distinct part.
  // A and B share their distinct part; C does not.
  const shared = [10, 10, 10, 10];
  const add = (base, extra) => base.map((v, i) => v + extra[i]);
  const a = add(shared, [1, 0, 0, 0]);
  const b = add(shared, [0.9, 0.1, 0, 0]);
  const c = add(shared, [0, 0, 1, 0]);

  // Raw: everything looks alike, and the gap is far too small to threshold on.
  const rawAB = cosine(a, b);
  const rawAC = cosine(a, c);
  assert.ok(rawAB > 0.99 && rawAC > 0.99, `raw scores were ${rawAB} and ${rawAC}`);
  assert.ok(rawAB - rawAC < 0.01, 'raw cosine barely separates related from unrelated');

  const mean = a.map((_, i) => (a[i] + b[i] + c[i]) / 3);
  const centre = (v) => v.map((x, i) => x - mean[i]);
  const cenAB = cosine(centre(a), centre(b));
  const cenAC = cosine(centre(a), centre(c));

  assert.ok(cenAB > cenAC, 'centred, the related pair must win');
  assert.ok(cenAB - cenAC > 0.5,
    `centring should open a real gap, got ${cenAB.toFixed(3)} vs ${cenAC.toFixed(3)}`);
});
