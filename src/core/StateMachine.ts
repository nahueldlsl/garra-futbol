export interface GameState<TId extends string> {
  readonly id: TId;
  enter?(prev?: TId): void;
  update(dt: number): void;
  render(): void;
  exit?(next?: TId): void;
}

/**
 * Máquina de estados genérica con ciclo enter / update / render / exit.
 */
export class StateMachine<TId extends string> {
  private readonly states = new Map<TId, GameState<TId>>();
  private current: GameState<TId> | null = null;

  public register(state: GameState<TId>): void {
    this.states.set(state.id, state);
  }

  public transitionTo(nextId: TId): void {
    const nextState = this.states.get(nextId);
    if (!nextState) {
      throw new Error(`Estado no registrado: ${nextId}`);
    }
    const prevId = this.current?.id;
    this.current?.exit?.(nextId);
    this.current = nextState;
    this.current.enter?.(prevId);
  }

  public update(dt: number): void {
    this.current?.update(dt);
  }

  public render(): void {
    this.current?.render();
  }

  public getCurrentId(): TId | null {
    return this.current?.id ?? null;
  }

  public getCurrentState(): GameState<TId> | null {
    return this.current;
  }
}
