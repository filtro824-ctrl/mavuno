import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentCountAllowed,
  cleanOriginalName,
  dailyQuotaAllows,
  MIB,
  signatureMatches,
  validateAttachmentMetadata,
} from '../src/server/attachment-utils.js';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (value: string) => new TextEncoder().encode(value);

test('allows each supported family and enforces its size cap', () => {
  assert.equal(validateAttachmentMetadata('foto.jpg', 'image/jpeg', 8 * MIB).ok, true);
  assert.equal(validateAttachmentMetadata('foto.jpg', 'image/jpeg', 8 * MIB + 1).ok, false);
  assert.equal(validateAttachmentMetadata('animacao.gif', 'image/gif', 10 * MIB).ok, true);
  assert.equal(validateAttachmentMetadata('video.mp4', 'video/mp4', 25 * MIB).ok, true);
  assert.equal(validateAttachmentMetadata('relatorio.pdf', 'application/pdf', 20 * MIB).ok, true);
  assert.equal(validateAttachmentMetadata('texto.txt', 'text/plain', 20 * MIB).ok, true);
  assert.equal(validateAttachmentMetadata('documento.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 20 * MIB).ok, true);
  assert.equal(validateAttachmentMetadata('dados.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 20 * MIB).ok, true);
  assert.equal(validateAttachmentMetadata('apresentacao.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 20 * MIB).ok, true);
  assert.equal(validateAttachmentMetadata('arquivo.zip', 'application/zip', 20 * MIB).ok, true);
});

test('rejects unsupported types, mismatched extensions, and empty or invalid sizes', () => {
  assert.deepEqual(validateAttachmentMetadata('imagem.svg', 'image/svg+xml', 100), { ok: false, reason: 'type' });
  assert.deepEqual(validateAttachmentMetadata('pagina.html', 'text/html', 100), { ok: false, reason: 'type' });
  assert.deepEqual(validateAttachmentMetadata('foto.png', 'image/jpeg', 100), { ok: false, reason: 'type' });
  assert.equal(validateAttachmentMetadata('vazio.txt', 'text/plain', 0).ok, false);
  assert.equal(validateAttachmentMetadata('vazio.txt', 'text/plain', Number.NaN).ok, false);
});

test('detects binary signatures and refuses a declared type that does not match', () => {
  assert.equal(signatureMatches('image/jpeg', bytes(0xff, 0xd8, 0xff, 0x00)), true);
  assert.equal(signatureMatches('image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), true);
  assert.equal(signatureMatches('image/gif', ascii('GIF89a')) , true);
  assert.equal(signatureMatches('image/webp', ascii('RIFF0000WEBP')) , true);
  assert.equal(signatureMatches('video/mp4', ascii('0000ftypisom')) , true);
  assert.equal(signatureMatches('video/webm', bytes(0x1a, 0x45, 0xdf, 0xa3, 0x00)), true);
  assert.equal(signatureMatches('application/pdf', ascii('%PDF-1.7')), true);
  assert.equal(signatureMatches('application/zip', bytes(0x50, 0x4b, 0x03, 0x04, 0x00)), true);
  assert.equal(signatureMatches('text/plain', ascii('Texto UTF-8')), true);
  assert.equal(signatureMatches('text/plain', bytes(0x41, 0x00, 0x42)), false);
  assert.equal(signatureMatches('text/plain', bytes(0xc3, 0x28)), false);
  assert.equal(signatureMatches('image/jpeg', ascii('<svg></svg>')), false);
});

test('blocks dangerous and double extensions even when the final extension is allowed', () => {
  for (const name of ['payload.exe', 'script.js.jpg', 'pagina.html.png', 'pacote.apk.zip', 'imagem.svg.webp', 'run.sh.pdf', 'arquivo.docx.exe']) {
    assert.equal(validateAttachmentMetadata(name, 'image/jpeg', 10).ok, false, name);
  }
});

test('cleans path separators, controls, header-sensitive characters, and excessive names', () => {
  assert.equal(cleanOriginalName('../../relatorio\n"final".pdf'), 'relatorio_final_.pdf');
  assert.equal(cleanOriginalName('C:\\Users\\utilizador\\foto.jpg'), 'foto.jpg');
  assert.equal(Array.from(cleanOriginalName(`${'a'.repeat(220)}.txt`)).length, 180);
  assert.equal(cleanOriginalName(''), 'ficheiro');
});

test('enforces a maximum of five attachments per message', () => {
  assert.equal(attachmentCountAllowed(0, 5), true);
  assert.equal(attachmentCountAllowed(4, 1), true);
  assert.equal(attachmentCountAllowed(4, 2), false);
  assert.equal(attachmentCountAllowed(0, 0), false);
  assert.equal(attachmentCountAllowed(-1, 1), false);
});

test('enforces the rolling daily quota of 100 MiB', () => {
  assert.equal(dailyQuotaAllows(0, 100 * MIB), true);
  assert.equal(dailyQuotaAllows(100 * MIB - 1, 1), true);
  assert.equal(dailyQuotaAllows(100 * MIB, 1), false);
  assert.equal(dailyQuotaAllows(-1, 1), false);
  assert.equal(dailyQuotaAllows(0, 0), false);
});
