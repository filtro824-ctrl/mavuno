import test from 'node:test';
import assert from 'node:assert/strict';
import { canActOnHierarchy, durationInRange, durationSeconds, isBanActive } from '../src/server/moderation-utils.js';

test('converts moderation duration units to seconds', () => {
  assert.equal(durationSeconds(5, 'minutes'), 300);
  assert.equal(durationSeconds(2, 'hours'), 7200);
  assert.equal(durationSeconds(3, 'days'), 259200);
});

test('enforces mute minimum and maximum of one minute and 28 days', () => {
  const minimum = 60;
  const maximum = 28 * 24 * 60 * 60;
  assert.equal(durationInRange(minimum, minimum, maximum), true);
  assert.equal(durationInRange(maximum, minimum, maximum), true);
  assert.equal(durationInRange(minimum - 1, minimum, maximum), false);
  assert.equal(durationInRange(maximum + 1, minimum, maximum), false);
});

test('enforces temporary ban minimum and maximum of one hour and 365 days', () => {
  const minimum = 60 * 60;
  const maximum = 365 * 24 * 60 * 60;
  assert.equal(durationInRange(minimum, minimum, maximum), true);
  assert.equal(durationInRange(maximum, minimum, maximum), true);
  assert.equal(durationInRange(minimum - 1, minimum, maximum), false);
  assert.equal(durationInRange(maximum + 1, minimum, maximum), false);
});

test('recognizes active, expired, revoked and permanent bans', () => {
  const now = new Date('2026-11-01T12:00:00.000Z');
  assert.equal(isBanActive(null, new Date('2026-11-01T13:00:00.000Z'), now), true);
  assert.equal(isBanActive(null, new Date('2026-11-01T11:59:59.000Z'), now), false);
  assert.equal(isBanActive(new Date('2026-11-01T11:00:00.000Z'), null, now), false);
  assert.equal(isBanActive(null, null, now), true);
});

test('only a strictly higher role may act, and owner is protected', () => {
  assert.equal(canActOnHierarchy(80, 50, 'moderator'), true);
  assert.equal(canActOnHierarchy(50, 50, 'moderator'), false);
  assert.equal(canActOnHierarchy(50, 80, 'admin'), false);
  assert.equal(canActOnHierarchy(100, 80, 'admin'), true);
  assert.equal(canActOnHierarchy(100, 100, 'owner'), false);
  assert.equal(canActOnHierarchy(null, 10, 'member'), false);
});
