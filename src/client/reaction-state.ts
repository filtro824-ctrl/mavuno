export interface ReactionSummary {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

export function toggleReactionSummary(items: ReactionSummary[], emoji: string): ReactionSummary[] {
  const current = items.find((item) => item.emoji === emoji);
  const next = items.filter((item) => item.emoji !== emoji);
  if (current?.reactedByMe) {
    if (current.count > 1) next.push({ ...current, count: current.count - 1, reactedByMe: false });
  } else if (current) {
    next.push({ ...current, count: current.count + 1, reactedByMe: true });
  } else {
    next.push({ emoji, count: 1, reactedByMe: true });
  }
  return next.sort((a, b) => a.emoji.localeCompare(b.emoji));
}
