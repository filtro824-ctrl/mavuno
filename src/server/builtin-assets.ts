export interface BuiltinAsset {
  key: string;
  label: string;
  description?: string;
}

export const BUILTIN_STICKERS: readonly BuiltinAsset[] = [
  ['ola', 'olá'], ['ok', 'ok'], ['festa', 'festa'], ['duvida', 'dúvida'], ['surpresa', 'surpresa'],
  ['sono', 'sono'], ['giro', 'giro'], ['corre', 'corre'], ['seta', 'seta'], ['coracao', 'coração'],
  ['mundo', 'mundo'], ['brilho', 'brilho'], ['musica', 'música'], ['logo', 'logótipo'], ['dados', 'dados'],
  ['bandeira', 'bandeira'], ['lua', 'lua'], ['estrela', 'estrela'], ['esfera', 'esfera'], ['trofeu', 'troféu'],
  ['apaixonado', 'apaixonado'], ['chorar', 'chorar'], ['zangado', 'zangado'], ['cool', 'fixe'], ['joinha', 'joinha'],
  ['rei', 'rei'], ['silencio', 'silêncio'], ['amor', 'amor'], ['obrigado', 'obrigado'], ['dj', 'dj'],
].map(([key, label]) => ({ key, label }));

export const BUILTIN_EMOJIS: readonly BuiltinAsset[] = [
  ['apaixonado', 'apaixonado'], ['chorar', 'chorar'], ['zangado', 'zangado'], ['cool', 'fixe'],
  ['joinha', 'joinha'], ['rei', 'rei'], ['silencio', 'silêncio'], ['obrigado', 'obrigado'],
].map(([key, label]) => ({ key, label }));

const stickerKeys = new Set(BUILTIN_STICKERS.map((item) => item.key));
const emojiKeys = new Set(BUILTIN_EMOJIS.map((item) => item.key));

export function builtinSticker(key: string): BuiltinAsset | null {
  return stickerKeys.has(key) ? BUILTIN_STICKERS.find((item) => item.key === key) ?? null : null;
}

export function builtinEmoji(key: string): BuiltinAsset | null {
  return emojiKeys.has(key) ? BUILTIN_EMOJIS.find((item) => item.key === key) ?? null : null;
}

export function builtinStickerUrl(key: string): string {
  return `/stickers/mavuno/${encodeURIComponent(key)}.png`;
}

export function builtinEmojiUrl(key: string): string {
  return `/emojis/mavuno/${encodeURIComponent(key)}.png`;
}
