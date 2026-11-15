/**
 * Constantes exactas de física, dimensiones, reglas, cámara e IA extraídas de `garrafut.exe` (SPECS.md).
 */

export const VIRTUAL_WIDTH = 400;
export const VIRTUAL_HEIGHT = 300;
export const DEFAULT_WINDOW_WIDTH = 800;
export const DEFAULT_WINDOW_HEIGHT = 600;
export const LOGIC_HZ = 30;
export const FIXED_DT = 1 / LOGIC_HZ;

/** Multiplicadores de `dt` físico según `GameOptions + 0x08` (`sub_42f290`). */
export const GAME_SPEED_SCALES = [0.65, 0.75, 1.0, 1.15] as const;

/** Duración total del partido en minutos según `menu.json` y `GameOptions + 0x0c`. */
export const MATCH_DURATION_MINUTES = [3, 6, 10, 15] as const;

export const FIELD = {
  halfWidth: 1440,
  halfDepth: 720,
  playerLimitX: 1424,
  playerLimitZ: 760,
  goalHalfZ: 117.12,
  goalHeight: 78,
  goalPostRadius: 5,
  goalDepth: 117.12,
  pitchHalfRenderWidth: 1536,
  pitchHalfRenderHeight: 512,
} as const;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Proyección trapezoidal 3D -> 2D exacta de `sub_464a20` (`0x464a20`, `.rdata 0x516df0..0x516e30`).
 */
export function projectWorldToScreen(x: number, y: number, z: number): ScreenPoint {
  const t = 0.5 * (z / FIELD.halfDepth + 1);
  const scaleX = 0.75 + 0.25 * t;
  return {
    x: Math.round(scaleX * x),
    y: Math.round(0.5 * z - y),
  };
}

/**
 * Inversa aproximada en suelo (`y = 0`) de pantalla 2D a coordenada lógica Z.
 */
export function unprojectScreenToWorldZ(screenY: number, y = 0): number {
  return (screenY + y) * 2;
}

export const BALL_PHYSICS = {
  gravity: -480,
  groundFriction: 100,
  airDrag: 0.35,
  restitution: 0.65,
  stopBounceVy: 20,
  immunityTime: 0.2,
  postRestitution: 0.8,
  netDamping: 0.15,
  parabolicBaseHeight: 63.08,
  parabolicMaxHeight: 156.16,
  radius: 6,
} as const;

export const PLAYER_PHYSICS = {
  maxSpeed: 280,
  driveAcc: 2000,
  dribbleSpeedFactor: 0.8,
  groundFriction: 800,
  gravity: 1200,
  collisionRadius: 20,
  pushForce: 180,
  pushReceptivity: 1.0,
  pickupRadius: 16,
  dribbleLookahead: 16,
  maxPickupHeight: 20,
  pickupMaxSpeed: 37,
  blockMaxSpeed: 700,
  runAnimMinSpeed: 120,
  animRefSpeed: 136,
  animSpeedFactor: 1.2,
} as const;

export const GOALKEEPER_CONFIG = {
  pickupRadius: 10,
  pickupMaxSpeed: 70,
  maxPickupHeight: 30,
  diveTriggerDist: 105,
  diveSpeed: 190,
  diveVy: 400,
  highDiveExtraVx: 100,
  highDiveVy: 450,
  catchMaxSpeed: 1000,
  kickMinSpeed: 120,
  kickMaxSpeed: 650,
  kickVy: 750,
} as const;

export interface KickLevelSpec {
  readonly id: 'kickLv0' | 'kickLv1' | 'kickLv2' | 'kickLv3' | 'kickLv4';
  readonly minCharge: number;
  readonly speed: number;
  readonly heightFactor: number;
  readonly inaccuracy: number;
  readonly extraAngle: number;
  readonly playPowerSfx: boolean;
}

export const KICK_LEVELS: readonly KickLevelSpec[] = [
  {
    id: 'kickLv0',
    minCharge: 0,
    speed: 394,
    heightFactor: 0.75,
    inaccuracy: 0.05 * Math.PI,
    extraAngle: 0,
    playPowerSfx: false,
  },
  {
    id: 'kickLv1',
    minCharge: 0,
    speed: 660,
    heightFactor: 0.1,
    inaccuracy: 0.05 * Math.PI,
    extraAngle: 0,
    playPowerSfx: false,
  },
  {
    id: 'kickLv2',
    minCharge: 0.1,
    speed: 660,
    heightFactor: 0.8,
    inaccuracy: 0.06 * Math.PI,
    extraAngle: 16,
    playPowerSfx: false,
  },
  {
    id: 'kickLv3',
    minCharge: 0.3,
    speed: 990,
    heightFactor: 0.8,
    inaccuracy: 0.05 * Math.PI,
    extraAngle: 16,
    playPowerSfx: true,
  },
  {
    id: 'kickLv4',
    minCharge: 0.6,
    speed: 1100,
    heightFactor: 1.0,
    inaccuracy: 0.1 * Math.PI,
    extraAngle: 64,
    playPowerSfx: true,
  },
] as const;

export const ACTION_CONFIG = {
  passSpeed: 420,
  passMinSpeed: 60,
  passInaccuracy: 0.05 * Math.PI,
  passHighHoldThreshold: 0.16,
  passHighHeightFactor: 1.1,
  headerMinY: 28,
  headerMaxY: 125,
  headerMaxDist: 190,
  headerJumpHorizSpeed: 260,
  headerJumpVy: 290,
  headerShotSpeed: 290,
  headerShotPowerSpeed: 860,
  headerPassSpeed: 340,
  tackleVx: 320,
  tackleVz: 60,
  tackleFriction: 320,
  tackleActiveTime: 0.42,
  tackleRecoveryTime: 0.35,
  evasionVy: 180,
  evasionDuration: 0.4,
  throwInHoldOffset: -20,
  throwInReleaseOffset: 20,
  throwInCarryHeight: 24,
  throwInAutoTimeout: 1.5,
  throwInWindupSeconds: 0.05,
  throwInTotalDuration: 0.75,
  throwInMaxSpeed: 600,
  diagonalNorm: Math.SQRT1_2,
} as const;

export const CAMERA_CONFIG = {
  lerpSpeed: 8.0,
  leadOffset: 100,
  leadLerp: 2.0,
  worldClampX: 1240,
  worldClampY: 570,
  renderClampX: FIELD.pitchHalfRenderWidth - VIRTUAL_WIDTH / 2,
  renderClampY: FIELD.pitchHalfRenderHeight - VIRTUAL_HEIGHT / 2,
} as const;

export const MATCH_TIMERS = {
  setPieceWaitSeconds: 1.0,
  goalWaitSeconds: 3.0,
  goalBannerSeconds: 5.0,
  matchEndDelaySeconds: 1.0,
  tacticalSideOffset: 60,
} as const;

/**
 * Resuelve la URL de un asset bajo `public/assets/` respetando `import.meta.env.BASE_URL`
 * para soportar despliegues en subrutas (ej. GitHub Pages).
 */
export function resolveAssetUrl(relPath: string): string {
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const cleanRel = relPath.replace(/^\/+/, '');
  return `${normalizedBase}assets/${cleanRel}`;
}
