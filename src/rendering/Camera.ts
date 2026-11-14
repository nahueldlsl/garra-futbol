import {
  CAMERA_CONFIG,
  projectWorldToScreen,
  type ScreenPoint,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
} from '../config/gameConfig';
import { clamp, type Vec3 } from '../entities/math3d';

export interface CameraProjection {
  readonly camScreenX: number;
  readonly camScreenY: number;
}

/**
 * Cámara 2D sobre la proyección trapezoidal `400x300` del campo `3072x1024`.
 */
export function computeCameraProjection(cameraPos: Vec3): CameraProjection {
  const projected = projectWorldToScreen(cameraPos.x, 0, cameraPos.z);
  return {
    camScreenX: clamp(projected.x, -CAMERA_CONFIG.renderClampX, CAMERA_CONFIG.renderClampX),
    camScreenY: clamp(projected.y, -CAMERA_CONFIG.renderClampY, CAMERA_CONFIG.renderClampY),
  };
}

export function worldToViewport(
  worldX: number,
  worldY: number,
  worldZ: number,
  cam: CameraProjection,
): ScreenPoint {
  const p = projectWorldToScreen(worldX, worldY, worldZ);
  return {
    x: Math.round(p.x - cam.camScreenX + VIRTUAL_WIDTH / 2),
    y: Math.round(p.y - cam.camScreenY + VIRTUAL_HEIGHT / 2),
  };
}
