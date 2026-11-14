export type InputProfile = 'menu' | 'P1_SOLO' | 'P1_2P' | 'P2_2P';

export type SemanticAction =
  'up' | 'down' | 'left' | 'right' | 'shot' | 'pass' | 'accept' | 'cancel' | 'pause';

export interface ProfileDirection {
  readonly x: number;
  readonly z: number;
}

export interface ActionStateSnapshot {
  readonly isDown: boolean;
  readonly justPressed: boolean;
  readonly justReleased: boolean;
  readonly holdDuration: number;
}

export interface InputReader {
  getDirection(profile: InputProfile): ProfileDirection;
  getAction(profile: InputProfile, action: SemanticAction): ActionStateSnapshot;
}

const EMPTY_ACTION: ActionStateSnapshot = {
  isDown: false,
  justPressed: false,
  justReleased: false,
  holdDuration: 0,
};

interface KeyBindings {
  readonly up: readonly string[];
  readonly down: readonly string[];
  readonly left: readonly string[];
  readonly right: readonly string[];
  readonly shot: readonly string[];
  readonly pass: readonly string[];
  readonly accept: readonly string[];
  readonly cancel: readonly string[];
  readonly pause: readonly string[];
}

const PROFILE_BINDINGS: Readonly<Record<InputProfile, KeyBindings>> = {
  menu: {
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    shot: ['KeyZ'],
    pass: ['KeyX'],
    accept: ['Enter', 'NumpadEnter', 'KeyZ'],
    cancel: ['Escape', 'KeyX'],
    pause: ['Escape'],
  },
  P1_SOLO: {
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    shot: ['KeyZ'],
    pass: ['KeyX'],
    accept: ['Enter', 'NumpadEnter', 'KeyZ'],
    cancel: ['Escape', 'KeyX'],
    pause: ['Escape'],
  },
  P1_2P: {
    up: ['KeyD'],
    down: ['KeyC'],
    left: ['KeyX'],
    right: ['KeyV'],
    shot: ['KeyQ'],
    pass: ['KeyW'],
    accept: ['KeyQ'],
    cancel: ['KeyW'],
    pause: ['Escape'],
  },
  P2_2P: {
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    shot: ['Period', 'key:.', 'key::'],
    pass: ['Slash', 'Minus', 'key:-', 'key:_'],
    accept: ['Period', 'Enter'],
    cancel: ['Slash', 'Minus'],
    pause: ['Escape'],
  },
};

const ALL_PROFILES: readonly InputProfile[] = ['menu', 'P1_SOLO', 'P1_2P', 'P2_2P'];
const ALL_ACTIONS: readonly SemanticAction[] = [
  'up',
  'down',
  'left',
  'right',
  'shot',
  'pass',
  'accept',
  'cancel',
  'pause',
];

interface MutableActionState {
  isDown: boolean;
  wasDown: boolean;
  justPressed: boolean;
  justReleased: boolean;
  holdDuration: number;
  lastHoldDuration: number;
}

/**
 * Gestor de entradas por teclado fiel a `sub_444340` (`0x444340`) y normalización diagonal (`0x40f8d0`).
 */
export class InputManager implements InputReader {
  private readonly rawCodes = new Set<string>();
  private readonly queuedPresses = new Set<string>();
  private readonly states = new Map<InputProfile, Record<SemanticAction, MutableActionState>>();
  private attached = false;
  private onAnyInteraction: (() => void) | null = null;

  public constructor() {
    for (const profile of ALL_PROFILES) {
      const record = {} as Record<SemanticAction, MutableActionState>;
      for (const action of ALL_ACTIONS) {
        record[action] = {
          isDown: false,
          wasDown: false,
          justPressed: false,
          justReleased: false,
          holdDuration: 0,
          lastHoldDuration: 0,
        };
      }
      this.states.set(profile, record);
    }
  }

  public setInteractionCallback(callback: () => void): void {
    this.onAnyInteraction = callback;
  }

  public attach(target: Window = window): void {
    if (this.attached || typeof target === 'undefined') {
      return;
    }
    this.attached = true;
    target.addEventListener('keydown', this.handleKeyDown);
    target.addEventListener('keyup', this.handleKeyUp);
    target.addEventListener('blur', this.handleBlur);
  }

  public detach(target: Window = window): void {
    if (!this.attached || typeof target === 'undefined') {
      return;
    }
    this.attached = false;
    target.removeEventListener('keydown', this.handleKeyDown);
    target.removeEventListener('keyup', this.handleKeyUp);
    target.removeEventListener('blur', this.handleBlur);
  }

  /** Simula una pulsación programática (útil para pruebas o controles táctiles). */
  public setVirtualKey(code: string, pressed: boolean): void {
    if (pressed) {
      if (!this.rawCodes.has(code)) {
        this.queuedPresses.add(code);
      }
      this.rawCodes.add(code);
    } else {
      this.rawCodes.delete(code);
    }
  }

  /** Actualiza flancos (`justPressed` / `justReleased`) y tiempos de carga para el paso fijo `dt`. */
  public advanceStep(dt: number): void {
    for (const profile of ALL_PROFILES) {
      const bindings = PROFILE_BINDINGS[profile];
      const profileState = this.states.get(profile);
      if (!profileState) {
        continue;
      }

      for (const action of ALL_ACTIONS) {
        const keys = bindings[action];
        const st = profileState[action];
        const isDownNow = keys.some((k) => this.rawCodes.has(k));
        const pressedViaQueue = keys.some((k) => this.queuedPresses.has(k));

        st.justPressed = (!st.wasDown && isDownNow) || (!st.wasDown && pressedViaQueue);
        st.justReleased = st.wasDown && !isDownNow;

        if (st.justReleased) {
          st.lastHoldDuration = st.holdDuration;
        }
        if (isDownNow) {
          st.holdDuration = st.justPressed ? dt : st.holdDuration + dt;
        } else {
          st.holdDuration = 0;
        }

        st.isDown = isDownNow;
        st.wasDown = isDownNow;
      }
    }
    this.queuedPresses.clear();
  }

  public getDirection(profile: InputProfile): ProfileDirection {
    const profileState = this.states.get(profile);
    if (!profileState) {
      return { x: 0, z: 0 };
    }
    let dx = 0;
    let dz = 0;
    if (profileState.left.isDown) dx -= 1;
    if (profileState.right.isDown) dx += 1;
    if (profileState.up.isDown) dz -= 1;
    if (profileState.down.isDown) dz += 1;

    const normSq = dx * dx + dz * dz;
    if (normSq > 0) {
      const invLen = 1 / Math.sqrt(normSq);
      return { x: dx * invLen, z: dz * invLen };
    }
    return { x: 0, z: 0 };
  }

  public getAction(profile: InputProfile, action: SemanticAction): ActionStateSnapshot {
    const st = this.states.get(profile)?.[action];
    if (!st) {
      return EMPTY_ACTION;
    }
    return {
      isDown: st.isDown,
      justPressed: st.justPressed,
      justReleased: st.justReleased,
      holdDuration: st.justReleased ? st.lastHoldDuration : st.holdDuration,
    };
  }

  public clearAll(): void {
    this.rawCodes.clear();
    this.queuedPresses.clear();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (
      event.code === 'ArrowUp' ||
      event.code === 'ArrowDown' ||
      event.code === 'ArrowLeft' ||
      event.code === 'ArrowRight' ||
      event.code === 'Space'
    ) {
      event.preventDefault();
    }

    this.onAnyInteraction?.();

    if (!this.rawCodes.has(event.code)) {
      this.queuedPresses.add(event.code);
    }
    this.rawCodes.add(event.code);

    const keyToken = `key:${event.key}`;
    if (!this.rawCodes.has(keyToken)) {
      this.queuedPresses.add(keyToken);
    }
    this.rawCodes.add(keyToken);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.rawCodes.delete(event.code);
    this.rawCodes.delete(`key:${event.key}`);
  };

  private readonly handleBlur = (): void => {
    this.clearAll();
  };
}
