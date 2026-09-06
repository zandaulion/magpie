import test from 'node:test';
import assert from 'node:assert/strict';
import { TOPIC_LINK, MIN_TOPIC_SIZE, MIN_COHESION, SAME_TOPIC_OVERLAP } from '../server/topics.js';

/**
 * These are the settled decisions rather than the arithmetic, because they are
 * the part a later change is most likely to undo by accident.
 */

test('a topic needs more than a pair', () => {
  // Two scraps that resemble each other are already served by connections,
  // which show on both cards. A topic is the thing you keep returning to.
  assert.ok(MIN_TOPIC_SIZE >= 3, 'a pair is a coincidence, not a subject');
});

test('topics form on a looser bar than connections', async () => {
  const { NEAR_THRESHOLD } = await import('../server/vectors.js');
  // A connection is a small event held to a high bar. A topic is the shape a
  // handful of scraps make together; at the connection bar, almost nothing
  // formed except pairs.
  assert.ok(TOPIC_LINK < NEAR_THRESHOLD,
    `topic link ${TOPIC_LINK} should sit below the connection bar ${NEAR_THRESHOLD}`);
  assert.ok(TOPIC_LINK > 0, 'but still above nothing at all');
});

test('a group has to hold together, not merely chain', () => {
  // Connected components use single linkage: A resembles B, B resembles C, and
  // C is dragged in regardless of A. On the first 43 scraps that produced one
  // group of eleven averaging 0.16 where the real ones averaged 0.30 and up.
  assert.ok(MIN_COHESION >= TOPIC_LINK,
    'the cohesion floor must be at least the linking bar, or chaining survives it');
});

test('reuse needs real overlap, not a single shared scrap', () => {
  // Too low and two unrelated groups would inherit each other's names; too
  // high and a topic that grew by one scrap would be treated as brand new and
  // lose the name someone typed.
  assert.ok(SAME_TOPIC_OVERLAP > 0.25 && SAME_TOPIC_OVERLAP < 0.75,
    `overlap ${SAME_TOPIC_OVERLAP} is outside the range where reuse is meaningful`);
});
