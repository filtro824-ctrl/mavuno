import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpaqueToken, digestToken, hashPassword, verifyPassword } from '../src/server/security.js';

test('hashes are salted and never store the original password', async () => {
  const first = await hashPassword('palavra-passe-de-teste-123');
  const second = await hashPassword('palavra-passe-de-teste-123');
  assert.match(first, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.notEqual(first, 'palavra-passe-de-teste-123');
  assert.notEqual(first, second);
});

test('password verification accepts only the matching password', async () => {
  const digest = await hashPassword('senha-correta-de-teste');
  assert.equal(await verifyPassword('senha-correta-de-teste', digest), true);
  assert.equal(await verifyPassword('senha-errada', digest), false);
});

test('malformed or unsupported hashes fail closed', async () => {
  assert.equal(await verifyPassword('qualquer', 'plain-text-password'), false);
  assert.equal(await verifyPassword('qualquer', 'md5$00$00'), false);
});

test('opaque session tokens are random and only a digest is suitable for storage', () => {
  const one = createOpaqueToken();
  const two = createOpaqueToken();
  assert.notEqual(one, two);
  assert.ok(one.length >= 40);
  assert.match(digestToken(one), /^[0-9a-f]{64}$/);
  assert.notEqual(digestToken(one), one);
});
