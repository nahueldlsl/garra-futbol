import type {
  AnimatedSpriteManifest,
  AnimationFrameStep,
  FgtImageEntry,
  SpriteAnimation,
  SpritesManifest,
} from '../data/types';
import type { AssetLoader } from './AssetLoader';

export function resolveAnimationStep(
  anim: SpriteAnimation,
  animTick: number,
): AnimationFrameStep | undefined {
  if (anim.frames.length === 0) return undefined;

  const totalTicks = Math.max(1, anim.totalTicks);
  const clampedTick = Math.max(0, animTick);

  if (anim.loop) {
    const loopIdx = anim.loopFrameIndex;
    if (loopIdx !== null && loopIdx > 0 && loopIdx < anim.frames.length) {
      let introTicks = 0;
      for (let i = 0; i < loopIdx; i += 1) {
        introTicks += Math.max(1, anim.frames[i].ticks);
      }
      if (clampedTick < introTicks) {
        let acc = 0;
        for (let i = 0; i < loopIdx; i += 1) {
          const step = anim.frames[i];
          acc += Math.max(1, step.ticks);
          if (clampedTick < acc) return step;
        }
      }
      let loopTicks = 0;
      for (let i = loopIdx; i < anim.frames.length; i += 1) {
        loopTicks += Math.max(1, anim.frames[i].ticks);
      }
      const targetTick = loopTicks > 0 ? (clampedTick - introTicks) % loopTicks : 0;
      let acc = 0;
      for (let i = loopIdx; i < anim.frames.length; i += 1) {
        const step = anim.frames[i];
        acc += Math.max(1, step.ticks);
        if (targetTick < acc) return step;
      }
      return anim.frames[anim.frames.length - 1];
    }

    const targetTick = ((animTick % totalTicks) + totalTicks) % totalTicks;
    let acc = 0;
    for (const step of anim.frames) {
      acc += Math.max(1, step.ticks);
      if (targetTick < acc) {
        return step;
      }
    }
    return anim.frames[anim.frames.length - 1];
  }

  const targetTick = Math.min(totalTicks - 0.001, clampedTick);
  let acc = 0;
  for (const step of anim.frames) {
    acc += Math.max(1, step.ticks);
    if (targetTick < acc) {
      return step;
    }
  }
  return anim.frames[anim.frames.length - 1];
}

export function findFgtImage(
  manifest: AnimatedSpriteManifest,
  groupId: number,
  frameIndex: number,
): FgtImageEntry | undefined {
  return (
    manifest.fgtImages.find((img) => img.groupId === groupId && img.frameIndex === frameIndex) ??
    manifest.fgtImages[0]
  );
}

export interface DrawAnimatedSpriteOptions {
  readonly flipX?: boolean;
}

/**
 * Dibuja un frame animado (`jugador.json` o `pelota.json`) respetando pivote, offsets y flip horizontal.
 */
export function drawAnimatedSprite(
  ctx: CanvasRenderingContext2D,
  manifest: AnimatedSpriteManifest,
  sheet: CanvasImageSource,
  animId: number,
  animTick: number,
  screenX: number,
  screenY: number,
  options: DrawAnimatedSpriteOptions = {},
): void {
  const anim = manifest.animations.find((a) => a.id === animId) ?? manifest.animations[0];
  if (!anim) return;

  const step = resolveAnimationStep(anim, animTick);
  if (!step) return;

  const entry = findFgtImage(manifest, step.groupId, step.frameIndex);
  if (!entry) return;

  const { rect, pivotX, pivotY } = entry;
  ctx.save();
  ctx.translate(Math.round(screenX + step.offset.dx), Math.round(screenY + step.offset.dy));
  const manifestFlipX = step.flip === 'H' || step.flip === 'HV' ? -1 : 1;
  const flipSignX = manifestFlipX * (options.flipX ? -1 : 1);
  const flipSignY = step.flip === 'V' || step.flip === 'HV' ? -1 : 1;
  const scaleX = flipSignX * Math.abs(step.scaleX || 1);
  const scaleY = flipSignY * Math.abs(step.scaleY || 1);
  if (scaleX !== 1 || scaleY !== 1) {
    ctx.scale(scaleX, scaleY);
  }
  ctx.drawImage(
    sheet,
    rect.x,
    rect.y,
    rect.w,
    rect.h,
    Math.round(-pivotX),
    Math.round(-pivotY),
    rect.w,
    rect.h,
  );
  ctx.restore();
}

export interface DrawStaticSpriteOptions {
  readonly flipX?: boolean;
  readonly alpha?: number;
  readonly imageOverride?: CanvasImageSource;
}

/**
 * Dibuja un sprite estático o frame de `sprites.json` alineado por `pivotX`, `pivotY`.
 */
export function drawStaticSprite(
  ctx: CanvasRenderingContext2D,
  spritesManifest: SpritesManifest,
  assets: AssetLoader,
  spriteKey: string,
  frameIndex: number,
  screenX: number,
  screenY: number,
  options: DrawStaticSpriteOptions = {},
): void {
  const sprite = spritesManifest.sprites[spriteKey];
  if (!sprite || sprite.frames.length === 0) return;

  const img = options.imageOverride ?? assets.getImage(sprite.path);
  if (!img) return;

  const idx =
    ((Math.floor(frameIndex) % sprite.frames.length) + sprite.frames.length) % sprite.frames.length;
  const frame = sprite.frames[idx];

  ctx.save();
  if (options.alpha !== undefined) {
    ctx.globalAlpha *= options.alpha;
  }
  ctx.translate(Math.round(screenX), Math.round(screenY));
  if (options.flipX) {
    ctx.scale(-1, 1);
  }
  ctx.drawImage(
    img,
    frame.x,
    frame.y,
    frame.w,
    frame.h,
    Math.round(-frame.pivotX),
    Math.round(-frame.pivotY),
    frame.w,
    frame.h,
  );
  ctx.restore();
}
