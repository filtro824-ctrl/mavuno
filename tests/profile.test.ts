import test from 'node:test';
import assert from 'node:assert/strict';
import { profileUpdateSchema, visibleMemberIdentity, visibleMemberProfile } from '../src/server/profile-utils.js';

const sample = {
  id: '72d16a4e-333a-44e3-a58d-45f5c78ecf95',
  username: 'amina',
  email: 'amina@example.test',
  avatarUrl: 'https://images.example.test/amina.png',
  aboutMe: 'Gosto de conversar.',
  createdAt: new Date('2025-02-01T10:00:00.000Z'),
  showAvatar: false,
  showAbout: false,
  showStatus: false,
  showJoinDate: false,
  showCommonCommunities: false,
  showEmail: false,
};

test('member identity omits a hidden avatar instead of returning it as null', () => {
  assert.deepEqual(visibleMemberIdentity(sample), { id: sample.id, username: sample.username });
  assert.deepEqual(visibleMemberIdentity({ ...sample, showAvatar: true }), {
    id: sample.id, username: sample.username, avatarUrl: sample.avatarUrl,
  });
});

test('public profile omits hidden fields and always keeps the username', () => {
  const result = visibleMemberProfile(sample, {
    online: true,
    commonCommunities: [{ id: 'common-1', name: 'Conversa' }],
    canViewEmail: true,
  });
  assert.deepEqual(result, { id: sample.id, username: sample.username });
  for (const key of ['email', 'avatarUrl', 'aboutMe', 'online', 'createdAt', 'commonCommunities']) {
    assert.equal(Object.hasOwn(result, key), false);
  }
});

test('visible fields are returned, but email still requires a manager and an enabled preference', () => {
  const visible = { ...sample, showAvatar: true, showAbout: true, showStatus: true, showJoinDate: true, showCommonCommunities: true };
  const commonCommunities = [{ id: 'common-1', name: 'Conversa' }];
  const memberView = visibleMemberProfile(visible, { online: true, commonCommunities, canViewEmail: false });
  assert.deepEqual(memberView, {
    id: sample.id,
    username: sample.username,
    avatarUrl: sample.avatarUrl,
    aboutMe: sample.aboutMe,
    online: true,
    createdAt: '2025-02-01T10:00:00.000Z',
    commonCommunities,
  });
  const emailVisible = visibleMemberProfile({ ...visible, showEmail: true }, { online: false, commonCommunities: [], canViewEmail: true });
  assert.equal(emailVisible.email, sample.email);
  assert.equal(Object.hasOwn(emailVisible, 'commonCommunities'), false);
});

test('profile update accepts a short about and HTTPS avatar but rejects HTTP and overlong text', () => {
  const valid = profileUpdateSchema.safeParse({ aboutMe: '  Olá!  ', avatarUrl: ' https://images.example.test/foto.png ' });
  assert.equal(valid.success, true);
  if (valid.success) assert.equal(valid.data.aboutMe, 'Olá!');
  assert.equal(profileUpdateSchema.safeParse({ avatarUrl: 'http://images.example.test/foto.png' }).success, false);
  assert.equal(profileUpdateSchema.safeParse({ aboutMe: 'x'.repeat(161) }).success, false);
  assert.equal(profileUpdateSchema.safeParse({ visibility: { avatar: true } }).success, false);
  assert.equal(profileUpdateSchema.safeParse({ passwordHash: 'not-allowed' }).success, false);
});
