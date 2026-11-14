import { resolveAssetUrl } from '../config/gameConfig';
import type { EventBus } from '../core/EventBus';
import type { AudioEntry, AudioManifest } from '../data/types';

interface ActiveSoundInstance {
  readonly key: string;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly loop: boolean;
}

/**
 * Administrador de audio sobre Web Audio API con canales separados de música/SFX,
 * precarga de `.ogg` desde `/assets/`, mute y desbloqueo automático ante interacción.
 */
export class AudioManager {
  private readonly manifest: AudioManifest;
  private readonly events: EventBus;
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;

  private readonly rawBytes = new Map<string, ArrayBuffer>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly activeInstances = new Map<string, Set<ActiveSoundInstance>>();
  private readonly pendingLoops = new Map<string, number>();

  private muted = false;
  private unlocked = false;
  private unsubscribes: Array<() => void> = [];

  constructor(manifest: AudioManifest, events: EventBus, initialMuted = false) {
    this.manifest = manifest;
    this.events = events;
    this.muted = initialMuted;
    this.bindEvents();
  }

  private bindEvents(): void {
    const unsubPlay = this.events.on('sound:play', ({ key, volumeScale }) => {
      this.play(key, volumeScale ?? 1.0);
    });
    const unsubStop = this.events.on('sound:stop', ({ key }) => {
      this.stop(key);
    });
    const unsubMute = this.events.on('sound:toggleMute', ({ enabled }) => {
      this.setMuted(!enabled);
    });
    this.unsubscribes.push(unsubPlay, unsubStop, unsubMute);
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') {
      return null;
    }
    if (this.ctx) {
      return this.ctx;
    }
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      return null;
    }

    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : 1;

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 1;

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 1;

    this.musicGain.connect(this.masterGain);
    this.sfxGain.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
    return this.ctx;
  }

  /**
   * Precarga todos los archivos `.ogg` declarados en `audio.json`.
   */
  public async preloadAll(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const entries = Object.entries(this.manifest.sounds);
    const total = entries.length;
    let loaded = 0;

    await Promise.all(
      entries.map(async ([key, entry]) => {
        try {
          const response = await fetch(resolveAssetUrl(entry.path));
          if (response.ok) {
            const bytes = await response.arrayBuffer();
            this.rawBytes.set(key, bytes);
            await this.tryDecode(key, bytes);
          }
        } catch {
          // Tolerar fallos individuales (e.g. modo offline parcial o codec no soportado)
        } finally {
          loaded += 1;
          onProgress?.(loaded, total);
        }
      }),
    );
  }

  private async tryDecode(key: string, bytes: ArrayBuffer): Promise<AudioBuffer | null> {
    if (this.buffers.has(key)) {
      return this.buffers.get(key) ?? null;
    }
    const ctx = this.ensureContext();
    if (!ctx) return null;

    try {
      const cloned = bytes.slice(0);
      const buffer = await ctx.decodeAudioData(cloned);
      this.buffers.set(key, buffer);
      if (this.pendingLoops.has(key) && this.unlocked) {
        const scale = this.pendingLoops.get(key) ?? 1.0;
        this.pendingLoops.delete(key);
        this.startBufferInstance(key, entryOrFallback(this.manifest.sounds[key]), buffer, scale);
      }
      return buffer;
    } catch {
      return null;
    }
  }

  public unlock(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => {
        this.unlocked = true;
        this.flushPendingLoops();
      });
    } else {
      this.unlocked = true;
      this.flushPendingLoops();
    }
  }

  private flushPendingLoops(): void {
    if (this.pendingLoops.size === 0) return;
    for (const [key, scale] of [...this.pendingLoops.entries()]) {
      const entry = this.manifest.sounds[key];
      const buffer = this.buffers.get(key);
      if (entry && buffer) {
        this.pendingLoops.delete(key);
        this.startBufferInstance(key, entry, buffer, scale);
      } else if (entry && this.rawBytes.has(key)) {
        void this.tryDecode(key, this.rawBytes.get(key)!);
      }
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(muted ? 0 : 1, this.ctx.currentTime);
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public play(key: string, volumeScale = 1.0): void {
    const entry = this.manifest.sounds[key];
    if (!entry) return;

    if (entry.loop && this.isLoopPlaying(key)) {
      return;
    }

    const buffer = this.buffers.get(key);
    if (!buffer || !this.ctx || !this.unlocked || this.ctx.state === 'suspended') {
      if (entry.loop) {
        this.pendingLoops.set(key, volumeScale);
      }
      if (!buffer && this.rawBytes.has(key)) {
        void this.tryDecode(key, this.rawBytes.get(key)!);
      }
      return;
    }

    this.startBufferInstance(key, entry, buffer, volumeScale);
  }

  private startBufferInstance(
    key: string,
    entry: AudioEntry,
    buffer: AudioBuffer,
    volumeScale: number,
  ): void {
    if (!this.ctx || !this.musicGain || !this.sfxGain) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = entry.loop;

    const gain = this.ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, entry.defaultVolume * volumeScale));

    const bus = entry.category === 'music' ? this.musicGain : this.sfxGain;
    source.connect(gain);
    gain.connect(bus);

    const instance: ActiveSoundInstance = { key, source, gain, loop: entry.loop };
    let bucket = this.activeInstances.get(key);
    if (!bucket) {
      bucket = new Set<ActiveSoundInstance>();
      this.activeInstances.set(key, bucket);
    }
    bucket.add(instance);

    source.onended = () => {
      bucket?.delete(instance);
    };

    try {
      source.start(0);
    } catch {
      bucket.delete(instance);
    }
  }

  public isLoopPlaying(key: string): boolean {
    const bucket = this.activeInstances.get(key);
    return bucket !== undefined && bucket.size > 0;
  }

  public stop(key: string): void {
    this.pendingLoops.delete(key);
    const bucket = this.activeInstances.get(key);
    if (!bucket) return;
    for (const inst of bucket) {
      try {
        inst.source.stop();
      } catch {
        // Ignorar si ya detuvo
      }
      inst.source.disconnect();
      inst.gain.disconnect();
    }
    bucket.clear();
  }

  public stopAllMusic(): void {
    for (const [key, entry] of Object.entries(this.manifest.sounds)) {
      if (entry.category === 'music') {
        this.stop(key);
      }
    }
  }

  public stopAll(): void {
    this.pendingLoops.clear();
    for (const key of this.activeInstances.keys()) {
      this.stop(key);
    }
  }

  public dispose(): void {
    this.stopAll();
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}

function entryOrFallback(entry: AudioEntry | undefined): AudioEntry {
  return (
    entry ?? {
      path: '',
      category: 'music',
      defaultVolume: 1,
      loop: true,
      sizeBytes: 0,
    }
  );
}
