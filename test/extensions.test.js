import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server/extensions.js', import.meta.url), 'utf8');

/**
 * The rules here are about authorship rather than arithmetic, and the risk is
 * that a later change quietly makes a regeneration overwrite something someone
 * rewrote. These pin the shape of the code that prevents it.
 */

test('a regeneration inserts; it never updates an existing reading', () => {
  const add = source.slice(source.indexOf('export function addExtension'),
                           source.indexOf('export function editExtension'));
  assert.ok(/INSERT INTO extensions/.test(add), 'addExtension must insert');
  assert.ok(!/UPDATE extensions/.test(add),
    'addExtension must never update: a second reading sits beside the first, '
    + 'or editing one would never be safe');
});

test('editing sets mine, and nothing clears it', () => {
  assert.ok(/UPDATE extensions SET body = \?, mine = 1/.test(source),
    'an edit must flip mine');
  assert.ok(!/mine\s*=\s*0\s*WHERE/.test(source),
    'nothing may set mine back to 0: once a person has been in there, the row '
    + 'stops being the model\'s however much of it survives');
});

test('every read and write is scoped to the account that owns the topic', () => {
  for (const fn of ['listExtensions', 'addExtension', 'editExtension', 'deleteExtension']) {
    const body = source.slice(source.indexOf(`export function ${fn}`));
    const next = body.indexOf('\nexport function');
    const scope = next === -1 ? body : body.slice(0, next);
    assert.ok(/account_id/.test(scope), `${fn} must check account ownership`);
  }
});

test('the model that wrote a reading is recorded, and not wiped by an edit', () => {
  assert.ok(/model/.test(source.slice(source.indexOf('export function addExtension'),
                                      source.indexOf('export function editExtension'))),
    'the model is stored with the reading');
  const edit = source.slice(source.indexOf('export function editExtension'),
                            source.indexOf('export function deleteExtension'));
  assert.ok(!/model\s*=/.test(edit),
    'an edit must leave the model name alone, so where it started stays knowable');
});

/**
 * The prompt used to contain two clauses that between them made silence a
 * legal answer -- "say less" and "say so briefly and stop". On one real topic
 * the model took that exit every time: six calls, zero output tokens, an
 * opaque 502, and the budget charged for each attempt.
 */
test('the extension prompt never permits an empty answer', () => {
  const gemini = readFileSync(new URL('../server/gemini.js', import.meta.url), 'utf8');
  const prompt = gemini.slice(gemini.indexOf('export async function extend'));

  assert.ok(/Un răspuns\s*\n?\s*gol nu e o opțiune|răspuns gol nu e o opțiune/.test(prompt),
    'the prompt must state outright that an empty answer is not an option');
  assert.ok(!/oprește-te/.test(prompt),
    '"stop" gives the model a way to answer with nothing at all');
  assert.ok(/Nu inventa un fir care nu e acolo/.test(prompt),
    'but it must still refuse to invent a thread that is not there');
});

test('a call that returns nothing is refunded', () => {
  const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const route = index.slice(index.indexOf("app.post('/api/topics/:id/extend'"),
                            index.indexOf("app.patch('/api/extensions/:id'"));
  assert.ok(/err\.code === 'empty'/.test(route) && /refund\(/.test(route),
    'an empty answer must refund: otherwise a topic that never answers can '
    + 'drain a daily budget one attempt at a time');
});
