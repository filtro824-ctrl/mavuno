import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canOpenConversation,
  countUnreadMessages,
  isBuiltinStickerKey,
  isValidDirectMessageBody,
  orderUserPair,
  presentDirectMessage,
} from '../src/server/direct-message-utils.js';

test('orders UUIDs lexicographically after lowercase normalization', () => {
  assert.deepEqual(orderUserPair('B0000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000000'), {
    userA: 'a0000000-0000-0000-0000-000000000000', userB: 'b0000000-0000-0000-0000-000000000000',
  });
});

test('requires a shared community without an active ban to open a conversation', () => {
  assert.equal(canOpenConversation(true), true);
  assert.equal(canOpenConversation(false), false);
});

const validationOptions = { builtinEmojiKeys: ['joinha'], builtinStickerKeys: ['ola'] };
test('validates message text, builtin emoji, length, custom markup and sticker-only bodies', () => {
  for (const body of ['Olá', '👍', 'Olá <:builtin:joinha>']) assert.equal(isValidDirectMessageBody(body, validationOptions), true, body);
  for (const body of ['', '   ', 'x'.repeat(2001), ':custom:', ':joinha:', '<:community:emoji>', '<:builtin:custom>']) {
    assert.equal(isValidDirectMessageBody(body, validationOptions), false, body.slice(0, 30));
  }
  assert.equal(isValidDirectMessageBody('', { ...validationOptions, stickerKey: 'ola' }), true);
  assert.equal(isValidDirectMessageBody('texto', { ...validationOptions, stickerKey: 'unknown' }), false);
});

test('validates builtin sticker keys only against the allowlist', () => {
  assert.equal(isBuiltinStickerKey('ola', ['ola', 'ok']), true);
  assert.equal(isBuiltinStickerKey('custom', ['ola', 'ok']), false);
});

test('counts only unread messages from others, excluding deleted messages and capping at 99', () => {
  const messages = [
    { authorId: 'me', createdAt: '2025-01-03T00:00:00Z' },
    { authorId: 'other', createdAt: '2025-01-01T00:00:00Z' },
    { authorId: 'other', createdAt: '2025-01-02T00:00:00Z' },
    { authorId: 'other', createdAt: '2025-01-03T00:00:00Z', deletedAt: '2025-01-04T00:00:00Z' },
    { authorId: 'other', createdAt: '2025-01-04T00:00:00Z' },
  ];
  assert.equal(countUnreadMessages(messages, 'me', '2025-01-02T00:00:00Z'), 1);
  assert.equal(countUnreadMessages(Array.from({ length: 120 }, (_, i) => ({ authorId: 'other', createdAt: new Date(Date.UTC(2025, 0, 1 + i)).toISOString() })), 'me', null), 99);
});

test('deleted message presentation never returns the original body', () => {
  assert.deepEqual(presentDirectMessage('segredo original', true), { body: 'Mensagem apagada', deleted: true });
  assert.deepEqual(presentDirectMessage('mensagem intacta', false), { body: 'mensagem intacta', deleted: false });
});
