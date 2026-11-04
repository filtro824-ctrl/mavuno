export interface DirectMessagePair {
  userA: string;
  userB: string;
}

export interface MessageBodyValidationOptions {
  builtinEmojiKeys: readonly string[];
  stickerKey?: string | null;
  builtinStickerKeys?: readonly string[];
}

export interface UnreadMessage {
  authorId: string;
  createdAt: Date | string;
  deletedAt?: Date | string | null;
}

export interface DirectMessagePresentation {
  body: string;
  deleted: boolean;
}

/** Canonicalize a user pair so both participants derive the same conversation key. */
export function orderUserPair(firstUserId: string, secondUserId: string): DirectMessagePair {
  const first = firstUserId.toLowerCase();
  const second = secondUserId.toLowerCase();
  return first <= second ? { userA: first, userB: second } : { userA: second, userB: first };
}

/** A new conversation can be opened only where both users share an unbanned community. */
export function canOpenConversation(hasSharedCommunityWithoutActiveBan: boolean): boolean {
  return hasSharedCommunityWithoutActiveBan === true;
}

/** Validate plain text and allow only explicit built-in emoji markup. */
export function isValidDirectMessageBody(body: string, options: MessageBodyValidationOptions): boolean {
  if (typeof body !== 'string' || body.length > 2000) return false;
  const stickerKey = options.stickerKey ?? null;
  if (stickerKey !== null && !(options.builtinStickerKeys ?? []).includes(stickerKey)) return false;
  if (!body.trim() && stickerKey === null) return false;

  const allowedEmojiKeys = new Set(options.builtinEmojiKeys);
  const markup = /<:([^<>]+)>|:([^:\s<>]+):/g;
  let match: RegExpExecArray | null;
  while ((match = markup.exec(body)) !== null) {
    if (!match[1]) return false;
    const builtinKey = match[1].match(/^builtin:([a-z0-9_-]+)$/i)?.[1];
    if (!builtinKey || !allowedEmojiKeys.has(builtinKey)) return false;
  }
  return true;
}

/** Check a sticker identifier against the fixed built-in sticker allowlist. */
export function isBuiltinStickerKey(key: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(key);
}

/** Count unread messages from other authors after the read cursor, capped at 99. */
export function countUnreadMessages(
  messages: readonly UnreadMessage[],
  currentUserId: string,
  lastReadAt: Date | string | null,
): number {
  const cursor = lastReadAt === null ? Number.NEGATIVE_INFINITY : new Date(lastReadAt).getTime();
  let count = 0;
  for (const message of messages) {
    if (message.authorId === currentUserId || message.deletedAt != null) continue;
    if (new Date(message.createdAt).getTime() > cursor) count++;
    if (count >= 99) return 99;
  }
  return count;
}

/** Redact deleted message content before it reaches a client. */
export function presentDirectMessage(body: string, deleted: boolean): DirectMessagePresentation {
  return deleted ? { body: 'Mensagem apagada', deleted: true } : { body, deleted: false };
}
