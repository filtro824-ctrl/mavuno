export interface ReactionAggregateRow {
  messageId: string;
  emoji: string;
  count: number | bigint;
  reactedByMe: boolean;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

const pictographicSequence = /^\p{Extended_Pictographic}(?:\uFE0F)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?(?:\p{Emoji_Modifier})?)*$/u;
const flagSequence = /^\p{Regional_Indicator}{2}$/u;
const keycapSequence = /^(?:[#*0-9])(?:\uFE0F)?\u20E3$/u;
const subdivisionFlagSequence = /^\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F}$/u;

/** Accept exactly one Unicode emoji grapheme, never text or markup. */
export function isUnicodeEmoji(value: string): boolean {
  if (!value || value.length > 32 || value.trim() !== value) return false;
  return pictographicSequence.test(value) || flagSequence.test(value) || keycapSequence.test(value) || subdivisionFlagSequence.test(value);
}

/** Convert a single aggregate query into per-message summaries without DB N+1 work. */
export function groupReactionAggregates(rows: ReactionAggregateRow[]): Record<string, ReactionSummary[]> {
  const grouped: Record<string, ReactionSummary[]> = Object.create(null) as Record<string, ReactionSummary[]>;
  for (const row of rows) {
    (grouped[row.messageId] ??= []).push({
      emoji: row.emoji,
      count: Number(row.count),
      reactedByMe: Boolean(row.reactedByMe),
    });
  }
  for (const summaries of Object.values(grouped)) summaries.sort((a, b) => a.emoji.localeCompare(b.emoji));
  return grouped;
}
