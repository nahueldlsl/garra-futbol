export type GlobalAppStateId =
  | 'loading'
  | 'logo'
  | 'mainMenu'
  | 'help'
  | 'credits'
  | 'teamSelection'
  | 'versus'
  | 'presentation'
  | 'soccer'
  | 'winner';

export type MatchEventCode = 3 | 4 | 5 | 6 | 7 | 8;

export interface GameEventMap {
  readonly 'sound:play': { readonly key: string; readonly volumeScale?: number };
  readonly 'sound:stop': { readonly key: string };
  readonly 'sound:toggleMute': { readonly enabled: boolean };
  readonly 'match:event': {
    readonly code: MatchEventCode;
    readonly teamSide?: 1 | -1;
    readonly details?: string;
  };
  readonly 'match:goal': {
    readonly scoringTeamSide: 1 | -1;
    readonly scorerName: string;
    readonly scorerNumber: number;
  };
  readonly 'screen:fade': { readonly kind: 'in' | 'out'; readonly duration: number };
  readonly 'app:navigate': { readonly to: GlobalAppStateId };
}

type EventListener<T> = (payload: T) => void;

/**
 * Bus de eventos tipado para desacoplar dominio, audio, renderizado y UI.
 */
export class EventBus {
  private readonly listeners = new Map<keyof GameEventMap, Set<EventListener<never>>>();

  public on<K extends keyof GameEventMap>(
    event: K,
    listener: EventListener<GameEventMap[K]>,
  ): () => void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set<EventListener<never>>();
      this.listeners.set(event, bucket);
    }
    bucket.add(listener as EventListener<never>);
    return () => {
      this.off(event, listener);
    };
  }

  public off<K extends keyof GameEventMap>(
    event: K,
    listener: EventListener<GameEventMap[K]>,
  ): void {
    const bucket = this.listeners.get(event);
    if (!bucket) {
      return;
    }
    bucket.delete(listener as EventListener<never>);
  }

  public emit<K extends keyof GameEventMap>(event: K, payload: GameEventMap[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) {
      return;
    }
    for (const listener of bucket) {
      (listener as EventListener<GameEventMap[K]>)(payload);
    }
  }

  public clear(): void {
    this.listeners.clear();
  }
}
