import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventBus } from '../../core/EventBus';
import type { AudioManifest } from '../../data/types';
import { AudioManager } from '../AudioManager';

const SAMPLE_MANIFEST: AudioManifest = {
  sounds: {
    bgmNormal: {
      path: 'audio/music/garrasoccer.ogg',
      category: 'music',
      defaultVolume: 0.25,
      loop: true,
      sizeBytes: 1000,
    },
    kick: {
      path: 'audio/fx/player/kick.ogg',
      category: 'sfx',
      defaultVolume: 0.8,
      loop: false,
      sizeBytes: 500,
    },
  },
};

describe('AudioManager', () => {
  it('syncs mute state via direct calls and EventBus events', () => {
    const events = new EventBus();
    const audio = new AudioManager(SAMPLE_MANIFEST, events, true);

    assert.equal(audio.isMuted(), true);
    events.emit('sound:toggleMute', { enabled: true });
    assert.equal(audio.isMuted(), false);

    events.emit('sound:toggleMute', { enabled: false });
    assert.equal(audio.isMuted(), true);

    audio.setMuted(false);
    assert.equal(audio.isMuted(), false);
    audio.dispose();
  });

  it('handles play/stop requests safely in headless environments without Web Audio', () => {
    const events = new EventBus();
    const audio = new AudioManager(SAMPLE_MANIFEST, events, false);

    events.emit('sound:play', { key: 'bgmNormal' });
    events.emit('sound:play', { key: 'unknownSound' });
    assert.equal(audio.isLoopPlaying('bgmNormal'), false);

    events.emit('sound:stop', { key: 'bgmNormal' });
    audio.stopAllMusic();
    audio.stopAll();
    audio.dispose();

    // After dispose, EventBus subscriptions should be cleaned up
    events.emit('sound:toggleMute', { enabled: false });
    assert.equal(audio.isMuted(), false);
  });
});
