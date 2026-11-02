import test from 'node:test';
import assert from 'node:assert/strict';
import {
  communityRulesAccepted,
  hasPendingJoinRequest,
  invitationIsValid,
  isWithinJoinRequestCooldown,
  JOIN_REQUEST_REJECTION_COOLDOWN_MS,
} from '../src/server/join-flow-utils.js';

const now = new Date('2026-11-02T10:00:00.000Z');
const validInvite = { revokedAt: null, expiresAt: '2026-11-09T10:00:00.000Z', maxUses: 5, useCount: 2 };

test('an invitation is invalid when revoked, expired or out of uses', () => {
  assert.equal(invitationIsValid(validInvite, now), true);
  assert.equal(invitationIsValid({ ...validInvite, revokedAt: now }, now), false);
  assert.equal(invitationIsValid({ ...validInvite, expiresAt: '2026-11-02T09:59:59.999Z' }, now), false);
  assert.equal(invitationIsValid({ ...validInvite, maxUses: 2, useCount: 2 }, now), false);
  assert.equal(invitationIsValid({ ...validInvite, maxUses: null, useCount: 200 }, now), true);
});

test('community rules require explicit acceptance only when rules exist', () => {
  assert.equal(communityRulesAccepted('Seja respeitoso.', false), false);
  assert.equal(communityRulesAccepted('Seja respeitoso.', true), true);
  assert.equal(communityRulesAccepted('   ', false), true);
  assert.equal(communityRulesAccepted('', false), true);
});

test('a second pending request for the same checked pair is not allowed', () => {
  const pendingRows = [{ status: 'pending' }];
  assert.equal(hasPendingJoinRequest(pendingRows), true);
  assert.equal(hasPendingJoinRequest([{ status: 'rejected' }, { status: 'cancelled' }]), false);
  assert.equal(hasPendingJoinRequest([]), false);
});

test('a rejected request starts a 24-hour cooldown', () => {
  const rejectedAt = new Date(now.getTime() - JOIN_REQUEST_REJECTION_COOLDOWN_MS + 1);
  assert.equal(isWithinJoinRequestCooldown(rejectedAt, now), true);
  assert.equal(isWithinJoinRequestCooldown(new Date(now.getTime() - JOIN_REQUEST_REJECTION_COOLDOWN_MS - 1), now), false);
  assert.equal(isWithinJoinRequestCooldown(null, now), false);
});
