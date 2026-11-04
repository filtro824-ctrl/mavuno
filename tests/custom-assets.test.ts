import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_STICKER_MAX_BYTES,
  extractEmojiReferences,
  isCustomAssetName,
  readImageDimensions,
  validateCustomImage,
} from '../src/server/custom-asset-utils.js';
import { BUILTIN_EMOJIS, BUILTIN_STICKERS, builtinEmoji, builtinSticker } from '../src/server/builtin-assets.js';

const png = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

const gif = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(10);
  bytes.set(new TextEncoder().encode('GIF89a'));
  new DataView(bytes.buffer).setUint16(6, width, true);
  new DataView(bytes.buffer).setUint16(8, height, true);
  return bytes;
};

const webp = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF0000WEBPVP8X'));
  bytes[24] = width - 1;
  bytes[27] = height - 1;
  return bytes;
};

test('validates names, formats, sizes and dimensions for community assets', () => {
  assert.equal(isCustomAssetName('ola_2'), true);
  assert.equal(isCustomAssetName('Acento'), false);
  assert.equal(isCustomAssetName('a'), false);
  assert.equal(isCustomAssetName('nome com espaço'), false);
  assert.equal(validateCustomImage('emoji', 'image/png', 100, png(128, 128)).ok, true);
  assert.equal(validateCustomImage('emoji', 'image/png', CUSTOM_EMOJI_MAX_BYTES + 1, png(32, 32)).ok, false);
  assert.equal(validateCustomImage('sticker', 'image/png', 100, png(321, 320)).ok, false);
  assert.equal(validateCustomImage('sticker', 'image/svg+xml', 100, png(32, 32)).ok, false);
});

test('reads PNG, GIF and WebP dimensions and marks animated types', () => {
  assert.deepEqual(readImageDimensions(png(64, 48), 'image/png'), { width: 64, height: 48, animated: false });
  assert.deepEqual(readImageDimensions(gif(12, 9), 'image/gif'), { width: 12, height: 9, animated: true });
  assert.deepEqual(readImageDimensions(webp(80, 70), 'image/webp'), { width: 80, height: 70, animated: false });
  assert.equal(readImageDimensions(new TextEncoder().encode('<svg/>'), 'image/svg+xml'), null);
  assert.equal(CUSTOM_STICKER_MAX_BYTES > CUSTOM_EMOJI_MAX_BYTES, true);
});

test('accepts only safe custom emoji references and blocks unknown markup references', () => {
  const refs = extractEmojiReferences('Olá <:ola:123e4567-e89b-12d3-a456-426614174000> <:builtin:cool> <script>bad</script>');
  assert.deepEqual(refs.map((item) => [item.kind, item.value]), [['custom', 'ola'], ['builtin', 'cool']]);
  assert.deepEqual(extractEmojiReferences('<:ola:outra-coisa>'), []);
});

test('contains exactly the fixed Mavuno package and rejects invented keys', () => {
  assert.equal(BUILTIN_STICKERS.length, 30);
  assert.equal(BUILTIN_EMOJIS.length, 8);
  assert.equal(builtinSticker('ola')?.label, 'olá');
  assert.equal(builtinEmoji('apaixonado')?.key, 'apaixonado');
  assert.equal(builtinSticker('../ola'), null);
  assert.equal(builtinEmoji('inventado'), null);
});
