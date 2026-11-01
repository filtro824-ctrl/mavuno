export type VoiceProfile = 'default' | 'noise-reduction' | 'studio';

export interface AudioPreferences {
  micMuted: boolean;
  deafened: boolean;
  voiceProfile: VoiceProfile;
  outputVolume: number;
  inputDeviceId: string;
  outputDeviceId: string;
}

export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  micMuted: false,
  deafened: false,
  voiceProfile: 'default',
  outputVolume: 100,
  inputDeviceId: '',
  outputDeviceId: '',
};

const STORAGE_KEY = 'mavuno.audio-preferences.v1';
const profiles: Record<VoiceProfile, { noiseSuppression: boolean; echoCancellation: boolean; autoGainControl: boolean }> = {
  default: { noiseSuppression: false, echoCancellation: true, autoGainControl: true },
  'noise-reduction': { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
  studio: { noiseSuppression: false, echoCancellation: false, autoGainControl: false },
};

export function readAudioPreferences(storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): AudioPreferences {
  if (!storage) return { ...DEFAULT_AUDIO_PREFERENCES };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AUDIO_PREFERENCES };
    const value = JSON.parse(raw) as Partial<AudioPreferences>;
    return {
      micMuted: value.micMuted === true,
      deafened: value.deafened === true,
      voiceProfile: value.voiceProfile === 'noise-reduction' || value.voiceProfile === 'studio' ? value.voiceProfile : 'default',
      outputVolume: typeof value.outputVolume === 'number' && Number.isFinite(value.outputVolume) ? Math.min(100, Math.max(0, value.outputVolume)) : 100,
      inputDeviceId: typeof value.inputDeviceId === 'string' ? value.inputDeviceId : '',
      outputDeviceId: typeof value.outputDeviceId === 'string' ? value.outputDeviceId : '',
    };
  } catch {
    return { ...DEFAULT_AUDIO_PREFERENCES };
  }
}

export function writeAudioPreferences(preferences: AudioPreferences, storage: Pick<Storage, 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): void {
  if (!storage) return;
  try { storage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* private mode or full storage: audio still works for this session */ }
}

export function microphoneConstraints(profile: VoiceProfile, deviceId = ''): MediaStreamConstraints {
  return { audio: { ...profiles[profile], ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } };
}

export function applyDeafenState(micMuted: boolean, deafened: boolean, nextDeafened: boolean): { micMuted: boolean; deafened: boolean; previousMicMuted: boolean | null } {
  if (nextDeafened) return { micMuted: true, deafened: true, previousMicMuted: micMuted };
  return { micMuted: deafened ? false : micMuted, deafened: false, previousMicMuted: null };
}

export function audioOutputVolume(preferences: AudioPreferences): number {
  return preferences.deafened ? 0 : preferences.outputVolume / 100;
}
