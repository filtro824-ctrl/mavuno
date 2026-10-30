import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { io as createSocket, type Socket } from 'socket.io-client';

const { Client: PgClient } = pg;

if (process.env.MAVUNO_RUN_INTEGRATION_TESTS !== '1') {
  throw new Error('Integração real desativada. Defina MAVUNO_RUN_INTEGRATION_TESTS=1 para permitir contas de teste temporárias.');
}
if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL não está configurado.');

const base = process.env.MAVUNO_TEST_BASE_URL ?? 'http://127.0.0.1:3000';
const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const usernameA = `testeA_${runId}`;
const usernameB = `testeB_${runId}`;
const emailA = `mavuno-a-${runId}@example.invalid`;
const emailB = `mavuno-b-${runId}@example.invalid`;
const password = `Mavuno-Teste-${randomUUID()}-A9`;
const emailAddresses = [emailA, emailB];
let socket: Socket | null = null;
let successfulChecks = 0;

class ApiSession {
  private readonly cookies = new Map<string, string>();
  private csrfToken = '';

  private cookieHeader(): string {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join('; ');
  }

  private saveCookies(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0];
      const splitAt = pair.indexOf('=');
      if (splitAt > 0) this.cookies.set(pair.slice(0, splitAt), pair.slice(splitAt + 1));
    }
  }

  async request<T = Record<string, unknown>>(path: string, options: {
    method?: string; body?: unknown; csrf?: boolean;
  } = {}): Promise<{ status: number; data: T; response: Response }> {
    const method = options.method ?? 'GET';
    const headers = new Headers();
    const cookie = this.cookieHeader();
    if (cookie) headers.set('cookie', cookie);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && options.csrf !== false && this.csrfToken) {
      headers.set('x-csrf-token', this.csrfToken);
    }
    const response = await fetch(new URL(path, base), {
      method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    this.saveCookies(response);
    const data = await response.json() as T;
    return { status: response.status, data, response };
  }

  async prepareCsrf(): Promise<void> {
    const result = await this.request<{ token: string }>('/api/auth/csrf');
    assert.equal(result.status, 200, 'CSRF bootstrap must succeed');
    this.csrfToken = result.data.token;
  }

  rawCookieHeader(): string { return this.cookieHeader(); }
}

function record(condition: boolean, label: string): void {
  assert.ok(condition, label);
  successfulChecks += 1;
}
function eventOnce<T>(target: Socket, event: string, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { target.off(event, handler); reject(new Error(`Socket event timeout: ${event}`)); }, timeoutMs);
    const handler = (value: T) => {
      if (!predicate(value)) return;
      clearTimeout(timer); target.off(event, handler); resolve(value);
    };
    target.on(event, handler);
  });
}

const userA = new ApiSession();
const userB = new ApiSession();

try {
  const health = await fetch(new URL('/api/health', base));
  const healthBody = await health.json() as { status: string; database: string };
  record(health.status === 200 && healthBody.status === 'ok' && healthBody.database === 'connected', 'HTTP readiness and PostgreSQL');
  const routesResponse = await fetch(new URL('/manus-routes.json', base));
  const routes = await routesResponse.json() as { routes?: Array<{ path: string }> };
  record(routesResponse.status === 200 && routesResponse.headers.get('content-type')?.includes('application/json') === true && routes.routes?.some((route) => route.path === '/invite/:token') === true, 'Static route manifest served as JSON');

  await Promise.all([userA.prepareCsrf(), userB.prepareCsrf()]);
  const registerA = await userA.request<{ user: { id: string; username: string } }>('/api/auth/register', {
    method: 'POST', body: { email: emailA, username: usernameA, password },
  });
  record(registerA.status === 201 && registerA.data.user.username === usernameA, 'Account A registration and session');
  const sessionCookie = registerA.response.headers.getSetCookie().find((header) => header.startsWith('mavuno_session='));
  record(Boolean(sessionCookie && /;\s*Secure/i.test(sessionCookie) && /;\s*SameSite=None/i.test(sessionCookie)), 'Session cookie is Secure and SameSite=None for HTTPS Preview');
  const registerB = await userB.request<{ user: { id: string; username: string } }>('/api/auth/register', {
    method: 'POST', body: { email: emailB, username: usernameB, password },
  });
  record(registerB.status === 201 && registerB.data.user.username === usernameB, 'Account B registration and session');

  const loginSession = new ApiSession();
  await loginSession.prepareCsrf();
  const login = await loginSession.request<{ user: { id: string } }>('/api/auth/login', { method: 'POST', body: { email: emailA, password } });
  record(login.status === 200 && login.data.user.id === registerA.data.user.id, 'Existing account can log in and receives a fresh session');
  const me = await loginSession.request<{ user: { id: string } }>('/api/auth/me');
  record(me.status === 200 && me.data.user.id === registerA.data.user.id, 'Authenticated session resolves the current user');
  const recovery = await loginSession.request<{ error: string }>('/api/auth/forgot', { method: 'POST', body: { email: emailA } });
  record(recovery.status === 503 && recovery.data.error.includes('não está configurada'), 'Recovery reports the unavailable email provider without pretending to send');

  const blockedWrite = await userA.request('/api/communities', {
    method: 'POST', csrf: false,
    body: { name: `Sem CSRF ${runId}`, description: '', category: 'Teste', isPrivate: true },
  });
  record(blockedWrite.status === 403, 'Mutation without CSRF token is rejected');

  const profile = await userB.request<{ user: { username: string; avatarUrl: string | null } }>('/api/profile', {
    method: 'PATCH', body: { username: usernameB, avatarUrl: 'https://example.invalid/avatar.png' },
  });
  record(profile.status === 200 && profile.data.user.avatarUrl === 'https://example.invalid/avatar.png', 'Profile name/avatar update');
  const profileClear = await userB.request('/api/profile', { method: 'PATCH', body: { avatarUrl: null } });
  record(profileClear.status === 200, 'Avatar can be removed');

  const createdPrivate = await userA.request<{ community: { id: string; isPrivate: boolean } }>('/api/communities', {
    method: 'POST', body: { name: `Privada ${runId}`, description: 'Apenas por convite', category: 'Teste', isPrivate: true },
  });
  record(createdPrivate.status === 201 && createdPrivate.data.community.isPrivate, 'Private community creation');
  const privateCommunityId = createdPrivate.data.community.id;
  const privateBeforeInvite = await userB.request(`/api/communities/${privateCommunityId}`);
  record(privateBeforeInvite.status === 404, 'Private community details are hidden from a non-member');

  const createdPublic = await userA.request<{ community: { id: string; isPrivate: boolean; name: string } }>('/api/communities', {
    method: 'POST', body: { name: `Publica ${runId}`, description: 'Descoberta de teste', category: 'Tecnologia', isPrivate: false },
  });
  record(createdPublic.status === 201 && !createdPublic.data.community.isPrivate, 'Public community creation');
  const publicCommunityId = createdPublic.data.community.id;
  const discovered = await userB.request<{ communities: Array<{ id: string }> }>(`/api/communities/explore?q=${encodeURIComponent(runId)}`);
  record(discovered.status === 200 && discovered.data.communities.some((community) => community.id === publicCommunityId) && !discovered.data.communities.some((community) => community.id === privateCommunityId), 'Public discovery filters by name/category and excludes private community');
  const discoveredByCategory = await userB.request<{ communities: Array<{ id: string }> }>('/api/communities/explore?q=Tecnologia');
  record(discoveredByCategory.status === 200 && discoveredByCategory.data.communities.some((community) => community.id === publicCommunityId), 'Public discovery also matches a category');
  const publicDetails = await userB.request<{ community: { id: string }; myRole: string | null }>(`/api/communities/${publicCommunityId}`);
  record(publicDetails.status === 200 && publicDetails.data.myRole === null, 'Public community detail page data is available without membership');
  const publicInvite = await userA.request<{ token: string }>(`/api/communities/${publicCommunityId}/invites`, { method: 'POST', body: {} });
  assert.equal(publicInvite.status, 201);
  const publicJoin = await userB.request(`/api/invites/${publicInvite.data.token}/join`, { method: 'POST', body: {} });
  assert.equal(publicJoin.status, 200);
  const publicMembership = await userB.request<{ communities: Array<{ id: string }> }>('/api/communities/mine');
  assert.ok(publicMembership.data.communities.some((community) => community.id === publicCommunityId));
  const leavePublic = await userB.request(`/api/communities/${publicCommunityId}/leave`, { method: 'POST', body: {} });
  record(leavePublic.status === 200, 'Member can voluntarily leave a community');
  const afterLeave = await userB.request<{ communities: Array<{ id: string }> }>('/api/communities/mine');
  record(afterLeave.status === 200 && !afterLeave.data.communities.some((community) => community.id === publicCommunityId), 'Voluntary leave removes community membership');

  const invite = await userA.request<{ token: string }>('/api/communities/' + privateCommunityId + '/invites', { method: 'POST', body: {} });
  record(invite.status === 201 && invite.data.token.length >= 32, 'Owner can create invitation');
  const joined = await userB.request<{ communityId: string }>('/api/invites/' + invite.data.token + '/join', { method: 'POST', body: {} });
  record(joined.status === 200 && joined.data.communityId === privateCommunityId, 'Second account joins via invitation');

  const detailA = await userA.request<{ channels: Array<{ id: string; kind: string; name: string }> }>(`/api/communities/${privateCommunityId}`);
  const textChannel = detailA.data.channels.find((channel) => channel.name === 'geral');
  assert.ok(textChannel, 'default text channel exists');
  const channelId = textChannel.id;
  const historyBefore = await userB.request<{ messages: unknown[] }>(`/api/channels/${channelId}/messages`);
  record(historyBefore.status === 200 && historyBefore.data.messages.length === 0, 'Member can open an empty text channel');

  socket = createSocket(base, { extraHeaders: { Cookie: userB.rawCookieHeader() }, transports: ['websocket'], reconnection: false, timeout: 10_000 });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.IO connection timed out')), 10_000);
    socket!.once('connect', () => { clearTimeout(timer); resolve(); });
    socket!.once('connect_error', (error) => { clearTimeout(timer); reject(new Error(`Socket.IO connection failed: ${error.message}`)); });
  });
  socket.emit('channel:join', { channelId });
  await new Promise((resolve) => setTimeout(resolve, 350));

  const firstClientId = randomUUID();
  const realtimeMessage = eventOnce<{ id: string; body: string }>(socket, 'message:new', (value) => value.body === `Olá @${usernameB} ${runId}`);
  const mentionEvent = eventOnce<{ channelId: string; messageId: string }>(socket, 'mention:new', (value) => value.channelId === channelId);
  const firstMessage = await userA.request<{ message: { id: string; body: string } }>(`/api/channels/${channelId}/messages`, {
    method: 'POST', body: { clientMessageId: firstClientId, body: `Olá @${usernameB} ${runId}` },
  });
  record(firstMessage.status === 201 && firstMessage.data.message.body.includes(usernameB), 'First account sends a persisted message');
  const [socketMessage, mention] = await Promise.all([realtimeMessage, mentionEvent]);
  record(socketMessage.id === firstMessage.data.message.id && mention.messageId === firstMessage.data.message.id, 'Second account receives real-time message and mention');

  const duplicate = await userA.request<{ message: { id: string } }>(`/api/channels/${channelId}/messages`, {
    method: 'POST', body: { clientMessageId: firstClientId, body: `Olá @${usernameB} ${runId}` },
  });
  record(duplicate.status === 200 && duplicate.data.message.id === firstMessage.data.message.id, 'Retry with same client idempotency key does not duplicate message');
  const persisted = await userB.request<{ messages: Array<{ id: string }> }>(`/api/channels/${channelId}/messages`);
  record(persisted.status === 200 && persisted.data.messages.some((message) => message.id === firstMessage.data.message.id), 'Message persists in PostgreSQL after a fresh request');

  for (let index = 0; index < 51; index += 1) {
    const result = await userA.request(`/api/channels/${channelId}/messages`, {
      method: 'POST', body: { clientMessageId: randomUUID(), body: `Paginação ${index} ${runId}` },
    });
    assert.equal(result.status, 201, `pagination message ${index} is accepted`);
  }
  const pageOne = await userA.request<{ messages: Array<{ id: string; createdAt: string }>; hasMore: boolean; nextCursor: string | null }>(`/api/channels/${channelId}/messages`);
  record(pageOne.status === 200 && pageOne.data.messages.length === 50 && pageOne.data.hasMore && Boolean(pageOne.data.nextCursor), 'History is limited to 50 messages and provides a cursor');
  const pageTwo = await userA.request<{ messages: Array<{ id: string }>; hasMore: boolean }>(`/api/channels/${channelId}/messages?before=${encodeURIComponent(pageOne.data.nextCursor!)}`);
  record(pageTwo.status === 200 && pageTwo.data.messages.length === 2 && !pageTwo.data.hasMore && !pageTwo.data.messages.some((message) => pageOne.data.messages.some((first) => first.id === message.id)), 'Cursor page has no duplicates and covers the remaining history');

  const reply = await userA.request<{ message: { id: string; replyToId: string | null } }>(`/api/channels/${channelId}/messages`, {
    method: 'POST', body: { clientMessageId: randomUUID(), body: `Resposta ${runId}`, replyToId: firstMessage.data.message.id },
  });
  record(reply.status === 201 && reply.data.message.replyToId === firstMessage.data.message.id, 'Reply remains linked to a message in this channel');

  const pin = await userA.request<{ message: { pinnedAt: string | null } }>(`/api/messages/${reply.data.message.id}/pin`, { method: 'POST', body: {} });
  record(pin.status === 200 && Boolean(pin.data.message.pinnedAt), 'Authorized moderator can pin a message');
  const pinnedHistory = await userB.request<{ messages: Array<{ id: string; pinnedAt: string | null }> }>(`/api/channels/${channelId}/messages`);
  record(pinnedHistory.status === 200 && pinnedHistory.data.messages.some((message) => message.id === reply.data.message.id && Boolean(message.pinnedAt)), 'Pinned state persists in PostgreSQL and is visible to members');
  const unpin = await userA.request(`/api/messages/${reply.data.message.id}/pin`, { method: 'DELETE' });
  record(unpin.status === 200, 'Authorized moderator can unpin a message');

  const mute = await userA.request<{ expiresAt: string }>(`/api/communities/${privateCommunityId}/members/${registerB.data.user.id}/mute`, { method: 'POST', body: { durationMinutes: 5, reason: 'Teste de moderação' } });
  record(mute.status === 200 && new Date(mute.data.expiresAt).getTime() > Date.now(), 'Owner can apply a temporary mute with an expiry');
  const mutedSend = await userB.request(`/api/channels/${channelId}/messages`, { method: 'POST', body: { clientMessageId: randomUUID(), body: `Bloqueada ${runId}` } });
  record(mutedSend.status === 403, 'Muted member cannot send messages through the HTTP API');
  const unmute = await userA.request(`/api/communities/${privateCommunityId}/members/${registerB.data.user.id}/mute`, { method: 'DELETE' });
  record(unmute.status === 200, 'Owner can remove an active mute');

  const ban = await userA.request(`/api/communities/${privateCommunityId}/members/${registerB.data.user.id}/ban`, { method: 'POST', body: { reason: 'Teste de banimento' } });
  record(ban.status === 200, 'Owner can ban a lower-hierarchy member');
  const bannedJoin = await userB.request(`/api/invites/${invite.data.token}/join`, { method: 'POST', body: {} });
  record(bannedJoin.status === 403, 'Banned member cannot rejoin through an invitation');
  const unban = await userA.request(`/api/communities/${privateCommunityId}/bans/${registerB.data.user.id}`, { method: 'DELETE' });
  record(unban.status === 200, 'Owner can revoke a ban');
  const rejoinAfterUnban = await userB.request(`/api/invites/${invite.data.token}/join`, { method: 'POST', body: {} });
  record(rejoinAfterUnban.status === 200, 'Revoked ban permits a new invitation join');

  const livekitConfigured = Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
  const rejectedCall = await userA.request<{ call: { id: string; status: string } }>('/api/calls', { method: 'POST', body: { calleeId: registerB.data.user.id } });
  record(rejectedCall.status === 201 && rejectedCall.data.call.status === 'ringing', 'Authenticated user can initiate a private call in ringing state');
  const rejectCall = await userB.request(`/api/calls/${rejectedCall.data.call.id}`, { method: 'PATCH', body: { status: 'rejected' } });
  record(rejectCall.status === 200, 'Recipient can reject a private call');
  const acceptedCall = await userA.request<{ call: { id: string; status: string } }>('/api/calls', { method: 'POST', body: { calleeId: registerB.data.user.id } });
  assert.equal(acceptedCall.status, 201);
  const acceptCall = await userB.request(`/api/calls/${acceptedCall.data.call.id}`, { method: 'PATCH', body: { status: 'accepted' } });
  record(acceptCall.status === 200, 'Recipient can accept a private call');
  const callToken = await userA.request<{ token?: string }>(`/api/calls/${acceptedCall.data.call.id}/token`, { method: 'POST', body: {} });
  if (livekitConfigured) record(callToken.status === 200 && Boolean(callToken.data.token), 'Accepted private call receives a server-issued LiveKit token');
  else record(callToken.status === 503, 'Private call reports missing LiveKit configuration without simulating audio');
  const endCall = await userA.request(`/api/calls/${acceptedCall.data.call.id}`, { method: 'PATCH', body: { status: 'ended' } });
  record(endCall.status === 200, 'Participant can terminate a private call');

  const voiceChannel = await userA.request<{ channel: { id: string; kind: string } }>(`/api/communities/${privateCommunityId}/channels`, {
    method: 'POST', body: { name: `voz_${runId}`, topic: 'Smoke test', kind: 'voice' },
  });
  record(voiceChannel.status === 201 && voiceChannel.data.channel.kind === 'voice', 'Authorized user creates a real voice-room database record');
  const voiceToken = await userA.request<{ token?: string; serverUrl?: string }>(`/api/channels/${voiceChannel.data.channel.id}/voice-token`, { method: 'POST', body: {} });
  if (livekitConfigured) record(voiceToken.status === 200 && Boolean(voiceToken.data.token) && Boolean(voiceToken.data.serverUrl), 'Backend issues a signed LiveKit token to an authorized member');
  else record(voiceToken.status === 503, 'Voice endpoint reports missing LiveKit configuration without simulation');

  const adminRole = await userA.request(`/api/communities/${privateCommunityId}/members/${registerB.data.user.id}/role`, { method: 'PATCH', body: { role: 'admin' } });
  record(adminRole.status === 200, 'Owner can assign administrator role');
  const adminChannel = await userB.request<{ channel: { id: string } }>(`/api/communities/${privateCommunityId}/channels`, {
    method: 'POST', body: { name: `admin_${runId}`, topic: '', kind: 'text' },
  });
  record(adminChannel.status === 201, 'Administrator can manage channels');
  const modRole = await userA.request(`/api/communities/${privateCommunityId}/members/${registerB.data.user.id}/role`, { method: 'PATCH', body: { role: 'moderator' } });
  record(modRole.status === 200, 'Owner can assign moderator role');
  const modChannel = await userB.request(`/api/communities/${privateCommunityId}/channels`, {
    method: 'POST', body: { name: `nochan_${runId}`, topic: '', kind: 'text' },
  });
  record(modChannel.status === 403, 'Moderator cannot manage channels');
  const modDelete = await userB.request(`/api/messages/${firstMessage.data.message.id}`, { method: 'DELETE' });
  record(modDelete.status === 200, 'Moderator can delete another member message');
  const memberRole = await userA.request(`/api/communities/${privateCommunityId}/members/${registerB.data.user.id}/role`, { method: 'PATCH', body: { role: 'member' } });
  record(memberRole.status === 200, 'Owner can return a user to member role');
  const memberInvite = await userB.request(`/api/communities/${privateCommunityId}/invites`, { method: 'POST', body: {} });
  record(memberInvite.status === 403, 'Member cannot create an invitation');
  const protectedMessage = await userA.request<{ message: { id: string } }>(`/api/channels/${channelId}/messages`, {
    method: 'POST', body: { clientMessageId: randomUUID(), body: `Protegida ${runId}` },
  });
  assert.equal(protectedMessage.status, 201);
  const memberDelete = await userB.request(`/api/messages/${protectedMessage.data.message.id}`, { method: 'DELETE' });
  record(memberDelete.status === 403, 'Ordinary member cannot delete another member message');

  const deleteExtraChannel = await userA.request(`/api/channels/${adminChannel.data.channel.id}`, { method: 'DELETE' });
  record(deleteExtraChannel.status === 200, 'Owner can delete a channel');
  const protectLastTextChannel = await userA.request(`/api/channels/${channelId}`, { method: 'DELETE' });
  record(protectLastTextChannel.status === 409, 'Community cannot lose its final text channel');

  const formerMemberMessage = await userB.request<{ message: { id: string } }>(`/api/channels/${channelId}/messages`, {
    method: 'POST', body: { clientMessageId: randomUUID(), body: `Mensagem própria antes da expulsão ${runId}` },
  });
  assert.equal(formerMemberMessage.status, 201);
  const beforeKickEvent = { count: 0 };
  socket.on('message:new', () => { beforeKickEvent.count += 1; });
  const kicked = await userA.request(`/api/communities/${privateCommunityId}/members/${registerB.data.user.id}`, { method: 'DELETE' });
  record(kicked.status === 200, 'Owner can remove a member');
  const deniedRejoin = eventOnce<{ error: string }>(socket!, 'room:error', (value) => value.error.includes('acesso'));
  socket!.emit('channel:join', { channelId });
  record((await deniedRejoin).error.length > 0, 'Kicked socket cannot rejoin a private channel');
  const afterKickMessage = eventOnce<{ body: string }>(socket, 'message:new', (value) => value.body === `Depois da expulsão ${runId}`, 1500).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const postKickSend = await userA.request(`/api/channels/${channelId}/messages`, {
    method: 'POST', body: { clientMessageId: randomUUID(), body: `Depois da expulsão ${runId}` },
  });
  assert.equal(postKickSend.status, 201);
  record(await afterKickMessage === null && beforeKickEvent.count === 0, 'Kicked socket no longer receives channel messages');
  const kickedHistory = await userB.request(`/api/channels/${channelId}/messages`);
  record(kickedHistory.status === 404, 'Removed member can no longer read private channel messages');
  const kickedDetails = await userB.request(`/api/communities/${privateCommunityId}`);
  record(kickedDetails.status === 404, 'Removed member can no longer read private community details');
  const kickedOwnDelete = await userB.request(`/api/messages/${formerMemberMessage.data.message.id}`, { method: 'DELETE' });
  record(kickedOwnDelete.status === 404, 'Removed member cannot delete own message through its retained ID');
  const messageRetained = await userA.request<{ messages: Array<{ id: string }> }>(`/api/channels/${channelId}/messages`);
  record(messageRetained.status === 200 && messageRetained.data.messages.some((message) => message.id === formerMemberMessage.data.message.id), 'Denied deletion leaves the message intact');

  const logout = await userB.request('/api/auth/logout', { method: 'POST', body: {} });
  record(logout.status === 200, 'Logout revokes persisted session');
  const afterLogout = await userB.request('/api/auth/me');
  record(afterLogout.status === 401, 'Revoked session no longer authenticates');

  console.log(JSON.stringify({ result: 'passed', checks: successfulChecks, realtime: 'two test sessions over Socket.IO', voiceTokenEndpoint: livekitConfigured ? 'signed token tested; device-to-device audio not tested' : 'not configured', testRowsCleanedOnExit: true }));
} catch (cause) {
  console.error('Integration smoke failed:', cause instanceof Error ? cause.message : 'unknown error');
  process.exitCode = 1;
} finally {
  if (socket) { socket.disconnect(); socket.close(); }
  try {
    const cleanup = new PgClient({ connectionString: process.env.POSTGRES_URL, connectionTimeoutMillis: 8000 });
    await cleanup.connect();
    const accounts = await cleanup.query<{ id: string }>('SELECT id FROM users WHERE email = ANY($1::text[])', [emailAddresses]);
    const ids = accounts.rows.map((row) => row.id);
    if (ids.length) await cleanup.query('DELETE FROM communities WHERE owner_id = ANY($1::uuid[])', [ids]);
    await cleanup.query('DELETE FROM users WHERE email = ANY($1::text[])', [emailAddresses]);
    await cleanup.end();
    console.log(`Temporary integration records removed: ${ids.length} user account(s).`);
  } catch (cause) {
    console.error('WARNING: targeted cleanup failed for temporary integration accounts:', cause instanceof Error ? cause.message : 'unknown error');
    process.exitCode = 1;
  }
}
