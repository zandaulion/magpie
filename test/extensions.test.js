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
