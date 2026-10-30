import test from 'node:test';
import assert from 'node:assert/strict';
import { groupReactionAggregates, isUnicodeEmoji } from '../src/server/reaction-utils.js';
import { toggleReactionSummary } from '../src/client/reaction-state.js';

test('accepts one Unicode emoji, including flags, keycaps, modifiers and joined emoji', () => {
  for (const value of ['👍', '👍🏽', '❤️', '😂', '🇲🇿', '1️⃣', '👨‍👩‍👧‍👦', '🏴\u{E006D}\u{E006F}\u{E007A}\u{E007F}']) assert.equal(isUnicodeEmoji(value), true, value);
});

test('rejects text, markup, empty values, multiple emoji and overlong values', () => {
  for (const value of ['', 'hello', '<b>👍</b>', '👍😂', 'a👍', '👍 ', '😀'.repeat(20)]) assert.equal(isUnicodeEmoji(value), false, value);
});

test('groups aggregates by message and preserves count and whether the current user reacted', () => {
  const grouped = groupReactionAggregates([
    { messageId: 'm1', emoji: '👍', count: 3, reactedByMe: true },
    { messageId: 'm1', emoji: '❤️', count: 2, reactedByMe: false },
    { messageId: 'm2', emoji: '😂', count: 1, reactedByMe: false },
  ]);
  assert.deepEqual(grouped.m1, [
    { emoji: '❤️', count: 2, reactedByMe: false },
    { emoji: '👍', count: 3, reactedByMe: true },
  ]);
  assert.deepEqual(grouped.m2, [{ emoji: '😂', count: 1, reactedByMe: false }]);
});

test('optimistic toggle adds, increments, decrements and removes a reaction summary', () => {
  const one = toggleReactionSummary([], '👍');
  assert.deepEqual(one, [{ emoji: '👍', count: 1, reactedByMe: true }]);
  assert.deepEqual(toggleReactionSummary([{ emoji: '👍', count: 1, reactedByMe: false }], '👍'), [{ emoji: '👍', count: 2, reactedByMe: true }]);
  assert.deepEqual(toggleReactionSummary([{ emoji: '👍', count: 3, reactedByMe: true }], '👍'), [{ emoji: '👍', count: 2, reactedByMe: false }]);
  assert.deepEqual(toggleReactionSummary([{ emoji: '👍', count: 1, reactedByMe: true }], '👍'), []);
});
