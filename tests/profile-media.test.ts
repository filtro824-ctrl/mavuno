import test from 'node:test';
import assert from 'node:assert/strict';
import { profileUpdateSchema } from '../src/server/profile-utils.js';
import {
  makeProfileMediaReference,
  parseProfileMediaReference,
  profileMediaObjectKey,
  profileMediaReferenceOwnedBy,
  profileMediaStagingObjectKey,
  PROFILE_MEDIA_MAX_BYTES,
} from '../src/server/profile-media-utils.js';

const ownerId = '123e4567-e89b-42d3-a456-426614174000';
const assetId = '987e6543-e21b-43d2-b654-123456789abc';

test('creates and parses a stable same-origin profile-media reference', () => {
  const reference = makeProfileMediaReference(ownerId, 'avatar', assetId);
  assert.equal(reference, `/api/profile-media/${ownerId}/avatar/${assetId}`);
  assert.deepEqual(parseProfileMediaReference(reference), { userId: ownerId, kind: 'avatar', assetId });
});

test('rejects external URLs, path variants and malformed identifiers as internal media references', () => {
  assert.equal(parseProfileMediaReference('https://images.example/photo.jpg'), null);
  assert.equal(parseProfileMediaReference(`//api/profile-media/${ownerId}/avatar/${assetId}`), null);
  assert.equal(parseProfileMediaReference(`/api/profile-media/${ownerId}/avatar/not-a-uuid`), null);
  assert.equal(parseProfileMediaReference(`/api/profile-media/${ownerId}/other/${assetId}`), null);
});

test('binds each reference to its owner and image slot', () => {
  const avatar = makeProfileMediaReference(ownerId, 'avatar', assetId);
  assert.equal(profileMediaReferenceOwnedBy(avatar, ownerId, 'avatar'), true);
  assert.equal(profileMediaReferenceOwnedBy(avatar, ownerId, 'banner'), false);
  assert.equal(profileMediaReferenceOwnedBy(avatar, '123e4567-e89b-42d3-a456-426614174001', 'avatar'), false);
});

test('uses distinct private final and temporary object-key prefixes', () => {
  assert.equal(profileMediaObjectKey(ownerId, 'banner', assetId), `profile-media/${ownerId}/banner/${assetId}.jpg`);
  assert.equal(profileMediaStagingObjectKey(ownerId, 'banner', assetId), `profile-upload-pending/${ownerId}/banner/${assetId}.jpg`);
  assert.equal(PROFILE_MEDIA_MAX_BYTES, 8 * 1024 * 1024);
});

test('profile updates accept stable app-owned media references and upload IDs only', () => {
  const reference = makeProfileMediaReference(ownerId, 'avatar', assetId);
  assert.equal(profileUpdateSchema.safeParse({ avatarUrl: reference }).success, true);
  assert.equal(profileUpdateSchema.safeParse({ avatarUrl: 'https://images.example/profile.jpg' }).success, true);
  assert.equal(profileUpdateSchema.safeParse({ avatarUploadId: assetId }).success, true);
  assert.equal(profileUpdateSchema.safeParse({ avatarUrl: '/api/profile-media/other/path' }).success, false);
  assert.equal(profileUpdateSchema.safeParse({ avatarUrl: 's3://private-bucket/profile.jpg' }).success, false);
});
