import { z } from 'zod';

export const categoryNameSchema = z.string().trim().min(1).max(40);
export const coverUrlSchema = z.string().url().max(500).refine((value) => value.startsWith('https://')).nullable().optional();
export const coverColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();

export function canWriteToChannel(readOnly: boolean, canManageChannels: boolean): boolean {
  return !readOnly || canManageChannels;
}

export interface UnreadMessageRow {
  channelId: string;
  messageId: string | null;
  authorId: string | null;
  userId: string;
  createdAt: Date | null;
  lastReadAt: Date | null;
  mentionUserId: string | null;
}

export function summarizeUnreadRows(rows: UnreadMessageRow[], limit = 99): Record<string, { unreadCount: number; hasMention: boolean }> {
  const summary: Record<string, { unreadCount: number; hasMention: boolean }> = {};
  for (const row of rows) {
    if (!row.messageId || !row.authorId || row.authorId === row.userId || !row.createdAt || !row.lastReadAt || row.createdAt.getTime() <= row.lastReadAt.getTime()) continue;
    const item = summary[row.channelId] ??= { unreadCount: 0, hasMention: false };
    item.unreadCount = Math.min(limit, item.unreadCount + 1);
    item.hasMention ||= row.mentionUserId !== null;
  }
  return summary;
}
