export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface KinematicBody3D {
  pos: Vec3;
  vel: Vec3;
  baseAcc: Vec3;
  /** Vector de dirección normalizado (`|dirAcc| <= 1`), escalado luego por `driveAccMag`. */
  dirAcc: Vec3;
  driveAccMag: number;
  maxSpeed: number;
  linearFriction: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function cloneVec3(v: Readonly<Vec3>): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function length3D(v: Readonly<Vec3>): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function lengthXZ(x: number, z: number): number {
  return Math.hypot(x, z);
}

export function distXZ(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function normalizeXZ(x: number, z: number): { readonly x: number; readonly z: number } {
  const len = Math.hypot(x, z);
  if (len <= 1e-6) {
    return { x: 0, z: 0 };
  }
  return { x: x / len, z: z / len };
}

/**
 * Integrador cinemático 3D exacto de `sub_478a60` (`0x478a60`, SPECS.md §2.2).
 */
export function integrateKinematic3D(body: KinematicBody3D, dt: number): void {
  if (dt <= 0) {
    body.dirAcc.x = 0;
    body.dirAcc.y = 0;
    body.dirAcc.z = 0;
    return;
  }

  // `dirAcc` representa una dirección en [0, 1]; acotar si supera magnitud 1 evita doble escalado accidental.
  const dirLen = Math.hypot(body.dirAcc.x, body.dirAcc.y, body.dirAcc.z);
  const dirScale = dirLen > 1 ? 1 / dirLen : 1;

  const ax = body.baseAcc.x + body.dirAcc.x * dirScale * body.driveAccMag;
  const ay = body.baseAcc.y + body.dirAcc.y * dirScale * body.driveAccMag;
  const az = body.baseAcc.z + body.dirAcc.z * dirScale * body.driveAccMag;

  body.dirAcc.x = 0;
  body.dirAcc.y = 0;
  body.dirAcc.z = 0;

  const halfDtSq = 0.5 * dt * dt;
  let dpx = body.vel.x * dt + ax * halfDtSq;
  let dpy = body.vel.y * dt + ay * halfDtSq;
  let dpz = body.vel.z * dt + az * halfDtSq;

  const dpLen = Math.hypot(dpx, dpy, dpz);
  const maxStep = body.maxSpeed * dt;
  if (dpLen > maxStep && dpLen > 1e-8) {
    const scale = maxStep / dpLen;
    dpx *= scale;
    dpy *= scale;
    dpz *= scale;
  }

  body.pos.x += dpx;
  body.pos.y += dpy;
  body.pos.z += dpz;

  body.vel.x += ax * dt;
  body.vel.y += ay * dt;
  body.vel.z += az * dt;

  const speed = Math.hypot(body.vel.x, body.vel.y, body.vel.z);
  const newSpeed = speed - body.linearFriction * dt;
  if (newSpeed > 0 && speed > 1e-8) {
    const ratio = newSpeed / speed;
    body.vel.x *= ratio;
    body.vel.y *= ratio;
    body.vel.z *= ratio;
  } else {
    body.vel.x = 0;
    body.vel.y = 0;
    body.vel.z = 0;
  }

  const clampedLen = Math.hypot(body.vel.x, body.vel.y, body.vel.z);
  if (clampedLen > body.maxSpeed && clampedLen > 1e-8) {
    const ratio = body.maxSpeed / clampedLen;
    body.vel.x *= ratio;
    body.vel.y *= ratio;
    body.vel.z *= ratio;
  }
}
