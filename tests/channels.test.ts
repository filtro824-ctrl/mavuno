import test from 'node:test';
import assert from 'node:assert/strict';
import { canWriteToChannel, categoryNameSchema, coverColorSchema, coverUrlSchema, summarizeUnreadRows } from '../src/server/channel-utils.js';

const readAt = new Date('2026-11-01T10:00:00.000Z');
const later = new Date('2026-11-01T10:01:00.000Z');
const row = (index: number, authorId: string, createdAt = later, mentionUserId: string | null = null) => ({
  channelId: 'channel-1', messageId: `message-${index}`, authorId, userId: 'viewer', createdAt, lastReadAt: readAt, mentionUserId,
});

test('unread summary counts only newer messages from other people and caps at 99', () => {
  const summary = summarizeUnreadRows([
    row(1, 'someone-else', later, 'viewer'),
    row(2, 'viewer'),
    row(3, 'someone-else', readAt),
    ...Array.from({ length: 102 }, (_, index) => row(index + 4, 'someone-else')),
  ]);
  assert.deepEqual(summary['channel-1'], { unreadCount: 99, hasMention: true });
});

test('category names accept trimmed 1–40 character names only', () => {
  assert.equal(categoryNameSchema.parse('  Geral  '), 'Geral');
  assert.equal(categoryNameSchema.safeParse('').success, false);
  assert.equal(categoryNameSchema.safeParse('x'.repeat(41)).success, false);
});

test('community cover URL requires HTTPS and a valid URL', () => {
  assert.equal(coverUrlSchema.safeParse('https://example.com/cover.jpg').success, true);
  assert.equal(coverUrlSchema.safeParse('http://example.com/cover.jpg').success, false);
  assert.equal(coverUrlSchema.safeParse('not-a-url').success, false);
  assert.equal(coverUrlSchema.safeParse(null).success, true);
});

test('community cover color requires #RRGGBB', () => {
  assert.equal(coverColorSchema.safeParse('#12aBcF').success, true);
  assert.equal(coverColorSchema.safeParse('#123').success, false);
  assert.equal(coverColorSchema.safeParse('red').success, false);
  assert.equal(coverColorSchema.safeParse(null).success, true);
});

test('read-only channels block members without manage_channels and permit managers', () => {
  assert.equal(canWriteToChannel(true, false), false);
  assert.equal(canWriteToChannel(true, true), true);
  assert.equal(canWriteToChannel(false, false), true);
});
