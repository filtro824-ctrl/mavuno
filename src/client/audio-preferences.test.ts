import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDeafenState, DEFAULT_AUDIO_PREFERENCES, readAudioPreferences, writeAudioPreferences } from './audio-preferences';

test('ensurdecer silencia o microfone e desensurdecer restaura o estado anterior', () => {
  const muted = applyDeafenState(false, false, true);
  assert.deepEqual(muted, { micMuted: true, deafened: true, previousMicMuted: false });
  assert.deepEqual({ micMuted: false, deafened: false }, { micMuted: muted.previousMicMuted, deafened: false });
  const alreadyMuted = applyDeafenState(true, false, true);
  assert.deepEqual(alreadyMuted, { micMuted: true, deafened: true, previousMicMuted: true });
});

test('preferências inválidas ou storage indisponível voltam aos valores seguros', () => {
  const storage = { value: '{"micMuted":"yes","deafened":true,"outputVolume":300,"voiceProfile":"bad"}', getItem() { return this.value; } };
  assert.deepEqual(readAudioPreferences(storage), { ...DEFAULT_AUDIO_PREFERENCES, deafened: true });
  assert.deepEqual(readAudioPreferences(undefined), DEFAULT_AUDIO_PREFERENCES);
});

test('grava preferências sem lançar quando o storage falha', () => {
  assert.doesNotThrow(() => writeAudioPreferences(DEFAULT_AUDIO_PREFERENCES, { setItem() { throw new Error('blocked'); } }));
});
