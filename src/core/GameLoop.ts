/** Timestep lógico fijo original: 1/30 s (30 Hz, SPECS.md §1.1 @ 0x469ea0). */
export const FIXED_TIMESTEP = 1 / 30;

export interface GameLoopCallbacks {
  readonly onUpdate: (dt: number) => void;
  readonly onRender: () => void;
  readonly fixedTimestep?: number;
  readonly maxFrameDt?: number;
}

/**
 * Game loop con acumulador determinista a paso fijo de 30 Hz.
 */
export class GameLoop {
  private readonly onUpdate: (dt: number) => void;
  private readonly onRender: () => void;
  private readonly fixedTimestep: number;
  private readonly maxFrameDt: number;

  private rafId: number | null = null;
  private lastTimestampMs: number | null = null;
  private accumulatorSeconds = 0;
  private running = false;

  public constructor(callbacks: GameLoopCallbacks) {
    this.onUpdate = callbacks.onUpdate;
    this.onRender = callbacks.onRender;
    this.fixedTimestep = callbacks.fixedTimestep ?? FIXED_TIMESTEP;
    this.maxFrameDt = callbacks.maxFrameDt ?? FIXED_TIMESTEP;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastTimestampMs = null;
    this.accumulatorSeconds = 0;
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  public stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastTimestampMs = null;
  }

  /** Avanza manualmente un paso lógico exacto (útil para pruebas deterministas). */
  public stepOnce(): void {
    this.onUpdate(this.fixedTimestep);
    this.onRender();
  }

  private readonly tick = (timestampMs: number): void => {
    if (!this.running) {
      return;
    }

    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs;
      this.onUpdate(this.fixedTimestep);
      this.onRender();
      this.rafId = window.requestAnimationFrame(this.tick);
      return;
    }

    const rawDt = Math.max(0, (timestampMs - this.lastTimestampMs) / 1000);
    this.lastTimestampMs = timestampMs;
    const clampedDt = Math.min(rawDt, this.maxFrameDt);
    this.accumulatorSeconds += clampedDt;

    while (this.accumulatorSeconds >= this.fixedTimestep) {
      this.onUpdate(this.fixedTimestep);
      this.accumulatorSeconds -= this.fixedTimestep;
    }

    this.onRender();
    this.rafId = window.requestAnimationFrame(this.tick);
  };
}
