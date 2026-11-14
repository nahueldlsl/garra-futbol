import { FIELD, projectWorldToScreen, VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from '../config/gameConfig';
import type { AssetManifests } from '../data/DataRepository';
import type { ColorsData } from '../data/types';
import { clamp } from '../entities/math3d';
import { getAllMatchPlayers, type MatchSessionState } from '../entities/MatchState';
import { MATCH_SUB_STATE } from '../entities/Referee';
import type { AssetLoader } from './AssetLoader';
import { BitmapFontRenderer } from './BitmapFontRenderer';
import { computeCameraProjection, worldToViewport } from './Camera';
import { PaletteSwapper } from './PaletteSwapper';
import { drawAnimatedSprite, drawStaticSprite } from './SpriteAnimator';

interface DepthRenderItem {
  readonly sortY: number;
  readonly draw: (ctx: CanvasRenderingContext2D) => void;
}

/**
 * Renderizador 2D pixel-perfect (`400x300` -> `800x600`) con perspectiva trapezoidal,
 * ordenamiento en Z (`painter's algorithm`), recoloreado de sprites y HUD completo.
 */
export class MatchRenderer {
  private readonly displayCanvas: HTMLCanvasElement;
  private readonly displayCtx: CanvasRenderingContext2D;
  private readonly virtualCanvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private readonly manifests: AssetManifests;
  private readonly assets: AssetLoader;
  public readonly fonts: BitmapFontRenderer;
  public readonly paletteSwapper: PaletteSwapper;

  private visualTick = 0;

  constructor(
    displayCanvas: HTMLCanvasElement,
    manifests: AssetManifests,
    colors: ColorsData,
    assets: AssetLoader,
  ) {
    this.displayCanvas = displayCanvas;
    const dCtx = displayCanvas.getContext('2d');
    if (!dCtx) {
      throw new Error('No se pudo inicializar CanvasRenderingContext2D en displayCanvas');
    }
    this.displayCtx = dCtx;

    this.virtualCanvas = document.createElement('canvas');
    this.virtualCanvas.width = VIRTUAL_WIDTH;
    this.virtualCanvas.height = VIRTUAL_HEIGHT;
    const vCtx = this.virtualCanvas.getContext('2d');
    if (!vCtx) {
      throw new Error('No se pudo inicializar buffer virtual 400x300');
    }
    vCtx.imageSmoothingEnabled = false;
    this.ctx = vCtx;

    this.manifests = manifests;
    this.assets = assets;
    this.fonts = new BitmapFontRenderer(manifests.fonts, assets);
    this.paletteSwapper = new PaletteSwapper(colors);
  }

  public getVirtualContext(): CanvasRenderingContext2D {
    return this.ctx;
  }

  public present(smoothPixels = false): void {
    this.displayCtx.imageSmoothingEnabled = smoothPixels;
    this.displayCtx.clearRect(0, 0, this.displayCanvas.width, this.displayCanvas.height);
    this.displayCtx.drawImage(
      this.virtualCanvas,
      0,
      0,
      VIRTUAL_WIDTH,
      VIRTUAL_HEIGHT,
      0,
      0,
      this.displayCanvas.width,
      this.displayCanvas.height,
    );
  }

  public renderMatch(match: MatchSessionState, smoothPixels: boolean, pitchType: 0 | 1): void {
    this.visualTick += 1;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0c1f0a';
    ctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);

    const cam = computeCameraProjection(match.camera.pos);
    const centerScreen = worldToViewport(0, 0, 0, cam);

    // 1. Cancha simétrica (mitad Este y mitad Oeste espejada desde X=0)
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      'pitch1',
      0,
      centerScreen.x,
      centerScreen.y,
    );
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      'pitch2',
      0,
      centerScreen.x,
      centerScreen.y,
    );
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      'pitch1',
      0,
      centerScreen.x,
      centerScreen.y,
      {
        flipX: true,
      },
    );
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      'pitch2',
      0,
      centerScreen.x,
      centerScreen.y,
      {
        flipX: true,
      },
    );

    if (pitchType === 1) {
      ctx.fillStyle = 'rgba(220, 195, 95, 0.08)';
      ctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    }

    const allPlayers = getAllMatchPlayers(match);

    // 2. Indicadores de jugador activo en suelo + sombras de jugadores y balón
    const pulseFrame = Math.floor(this.visualTick / 8) % 2;
    const activeLeft = match.teamLeft.players[match.teamLeft.activePlayerIndex];
    if (activeLeft) {
      const p = worldToViewport(activeLeft.pos.x, 0, activeLeft.pos.z, cam);
      drawStaticSprite(
        ctx,
        this.manifests.sprites,
        this.assets,
        'selection_J1',
        pulseFrame,
        p.x,
        p.y,
      );
    }
    const activeRight = match.teamRight.players[match.teamRight.activePlayerIndex];
    if (activeRight) {
      const p = worldToViewport(activeRight.pos.x, 0, activeRight.pos.z, cam);
      drawStaticSprite(
        ctx,
        this.manifests.sprites,
        this.assets,
        'selection_J2',
        pulseFrame,
        p.x,
        p.y,
      );
    }

    for (const player of allPlayers) {
      const sp = worldToViewport(player.pos.x, 0, player.pos.z, cam);
      drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'shadows', 0, sp.x, sp.y + 1, {
        alpha: 0.55,
      });
    }

    const ballShadow = worldToViewport(match.ball.pos.x, 0, match.ball.pos.z, cam);
    const heightAlpha = clamp(0.65 - match.ball.pos.y * 0.002, 0.2, 0.65);
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      'shadows',
      1,
      ballShadow.x,
      ballShadow.y + 1,
      {
        alpha: heightAlpha,
      },
    );

    // 3. Cola ordenada en profundidad (`painter's algorithm` por Y en suelo)
    const items: DepthRenderItem[] = [];
    const baseJugImg = this.assets.getImage(this.manifests.jugador.imagePath);
    const ballImg = this.assets.getImage(this.manifests.pelota.imagePath);

    if (baseJugImg) {
      for (const player of allPlayers) {
        const teamData = player.teamSide === 1 ? match.teamLeft.data : match.teamRight.data;
        const groundProj = projectWorldToScreen(player.pos.x, 0, player.pos.z);
        const drawPos = worldToViewport(player.pos.x, player.pos.y, player.pos.z, cam);
        const isHumanJ1 = match.teamLeft.controlMode !== 'CPU' && activeLeft?.uid === player.uid;
        const isHumanJ2 = match.teamRight.controlMode !== 'CPU' && activeRight?.uid === player.uid;

        items.push({
          sortY: groundProj.y,
          draw: (c) => {
            const sheet = this.paletteSwapper.getPlayerSheet(
              baseJugImg,
              'Jugador',
              teamData,
              player.data,
            );
            const gkFlipX =
              player.isGoalkeeper &&
              player.actionState === 'gkJump' &&
              (player.animId === 102 ? player.teamSide === -1 : player.teamSide === 1);
            drawAnimatedSprite(
              c,
              this.manifests.jugador,
              sheet,
              player.animId,
              player.animTick,
              drawPos.x,
              drawPos.y,
              { flipX: gkFlipX },
            );

            if (isHumanJ1) {
              drawStaticSprite(
                c,
                this.manifests.sprites,
                this.assets,
                'various',
                0,
                drawPos.x,
                drawPos.y - 46,
              );
            } else if (isHumanJ2) {
              drawStaticSprite(
                c,
                this.manifests.sprites,
                this.assets,
                'various',
                1,
                drawPos.x,
                drawPos.y - 46,
              );
            }

            // Barra de potencia cuando el jugador carga tiro o pase elevado
            if (player.isChargingShot || player.isChargingPass) {
              const ratio = player.isChargingShot
                ? clamp(player.shotChargeTimer / 0.75, 0.08, 1)
                : clamp(player.passChargeTimer / 0.5, 0.08, 1);
              const barW = 22;
              const barX = drawPos.x - 11;
              const barY = drawPos.y - 44;
              c.fillStyle = '#000000';
              c.fillRect(barX - 1, barY - 1, barW + 2, 5);
              c.fillStyle = player.isChargingShot
                ? ratio > 0.75
                  ? '#ff3020'
                  : '#ffd820'
                : '#40d0ff';
              c.fillRect(barX, barY, Math.round(barW * ratio), 3);
            }
          },
        });
      }
    }

    if (ballImg) {
      const ballGroundProj = projectWorldToScreen(match.ball.pos.x, 0, match.ball.pos.z);
      const ballPos = worldToViewport(match.ball.pos.x, match.ball.pos.y, match.ball.pos.z, cam);
      items.push({
        sortY: ballGroundProj.y + 1,
        draw: (c) => {
          const animTick = this.visualTick * (match.ball.spinAnimId === 20 ? 0 : 1);
          drawAnimatedSprite(
            c,
            this.manifests.pelota,
            ballImg,
            match.ball.spinAnimId,
            animTick,
            ballPos.x,
            ballPos.y,
          );
        },
      });
    }

    // Banderines de córner y estructuras de ambos arcos (`props` estáticos)
    for (const gx of [-FIELD.halfWidth, FIELD.halfWidth] as const) {
      const isWest = gx < 0;
      for (const cz of [-FIELD.halfDepth, FIELD.halfDepth] as const) {
        const gp = projectWorldToScreen(gx, 0, cz);
        const dp = worldToViewport(gx, 0, cz, cam);
        items.push({
          sortY: gp.y,
          draw: (c) => {
            drawStaticSprite(c, this.manifests.sprites, this.assets, 'props', 0, dp.x, dp.y);
          },
        });
      }

      const northGp = projectWorldToScreen(gx, 0, -FIELD.goalHalfZ);
      const northDp = worldToViewport(gx, 0, -FIELD.goalHalfZ, cam);
      items.push({
        sortY: northGp.y,
        draw: (c) => {
          drawStaticSprite(
            c,
            this.manifests.sprites,
            this.assets,
            'props',
            1,
            northDp.x,
            northDp.y,
            {
              flipX: isWest,
            },
          );
        },
      });

      const southGp = projectWorldToScreen(gx, 0, FIELD.goalHalfZ);
      const southDp = worldToViewport(gx, 0, FIELD.goalHalfZ, cam);
      items.push({
        sortY: southGp.y + 4,
        draw: (c) => {
          drawStaticSprite(
            c,
            this.manifests.sprites,
            this.assets,
            'props',
            2,
            southDp.x,
            southDp.y,
            {
              flipX: isWest,
            },
          );
        },
      });
    }

    items.sort((a, b) => a.sortY - b.sortY);
    for (const item of items) {
      item.draw(ctx);
    }

    // 4. Interfaz HUD
    this.renderHud(ctx, match);

    // 5. Fade de transición entre pelota parada/gol
    if (match.fadeAlpha > 0.01) {
      ctx.fillStyle = `rgba(0, 0, 0, ${clamp(match.fadeAlpha, 0, 1).toFixed(3)})`;
      ctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    }

    this.present(smoothPixels);
  }

  private renderHud(ctx: CanvasRenderingContext2D, match: MatchSessionState): void {
    // 1. Marcador compacto arriba a la izquierda (`interface` frame 2: 76x28)
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'interface', 2, 42, 8, {
      alpha: 0.85,
    });
    this.fonts.drawText(ctx, 'smallFont', match.teamLeft.data.shortName, 59, 11, {
      align: 'center',
    });
    this.fonts.drawText(ctx, 'smallFont', match.teamRight.data.shortName, 99, 11, {
      align: 'center',
    });
    this.fonts.drawText(ctx, 'smallFont', `${match.teamLeft.score}`, 59, 24, { align: 'center' });
    this.fonts.drawText(ctx, 'smallFont', `${match.teamRight.score}`, 99, 24, { align: 'center' });

    // 2. Logo sponsor `CALCAR` centrado arriba
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'calcar', 0, VIRTUAL_WIDTH / 2, 18);

    // 3. Reloj analógico (`hudTimer`), número de tiempo y reloj `MM:SS` arriba a la derecha
    const ratio = clamp(match.elapsedSeconds / Math.max(1, match.halfDurationSeconds), 0, 1);
    const timerFrame = Math.min(29, Math.floor(ratio * 29));
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'hudTimer', timerFrame, 299, 21);
    this.fonts.drawText(ctx, 'smallFont', `${match.half}`, 291, 13);

    const scaledSeconds = Math.floor(ratio * 45 * 60);
    const mins = String(Math.floor(scaledSeconds / 60)).padStart(2, '0');
    const secs = String(scaledSeconds % 60).padStart(2, '0');
    this.fonts.drawText(ctx, 'smallFont', `${mins}:${secs}`, 314, 17);

    // 4. Radar / minimapa traslúcido inferior centrado
    const miniX = VIRTUAL_WIDTH / 2;
    const miniY = 251;
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'minimap', 0, miniX, miniY, {
      alpha: 0.72,
    });

    const mapPoint = (wx: number, wz: number) => ({
      x: miniX + (wx / FIELD.halfWidth) * 56,
      y: miniY + (wz / FIELD.halfDepth) * 26,
    });

    for (const p of match.teamLeft.players) {
      const pt = mapPoint(p.pos.x, p.pos.z);
      drawStaticSprite(
        ctx,
        this.manifests.sprites,
        this.assets,
        'minimap_J1',
        p.isGoalkeeper ? 2 : 0,
        pt.x,
        pt.y,
      );
    }
    for (const p of match.teamRight.players) {
      const pt = mapPoint(p.pos.x, p.pos.z);
      drawStaticSprite(
        ctx,
        this.manifests.sprites,
        this.assets,
        'minimap_J2',
        p.isGoalkeeper ? 2 : 0,
        pt.x,
        pt.y,
      );
    }
    const ballPt = mapPoint(match.ball.pos.x, match.ball.pos.z);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'various', 3, ballPt.x, ballPt.y);

    // 5. Barras inferiores traslúcidas con dorsal y nombre del jugador activo
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'interface', 0, 0, 266, {
      alpha: 0.72,
    });
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      'interface',
      1,
      VIRTUAL_WIDTH - 136,
      266,
      {
        alpha: 0.72,
      },
    );

    const pLeft = match.teamLeft.players[match.teamLeft.activePlayerIndex];
    if (pLeft) {
      const label = `${pLeft.data.number} ${pLeft.data.name.slice(0, 12)}`;
      this.fonts.drawText(ctx, 'smallFont', label, 65, 269, { align: 'center' });
    }
    const pRight = match.teamRight.players[match.teamRight.activePlayerIndex];
    if (pRight) {
      const label = `${pRight.data.number} ${pRight.data.name.slice(0, 12)}`;
      this.fonts.drawText(ctx, 'smallFont', label, VIRTUAL_WIDTH - 65, 269, { align: 'center' });
    }

    // Banner de evento (saque, gol, lateral, córner, entretiempo, final)
    if (match.activeSignSprite) {
      const blinkHide =
        match.activeSignSprite === 'gol' &&
        Math.floor(match.stateTimer * 10) % 2 === 1 &&
        match.stateTimer > 1.8;
      if (!blinkHide) {
        drawStaticSprite(
          ctx,
          this.manifests.sprites,
          this.assets,
          match.activeSignSprite,
          0,
          VIRTUAL_WIDTH / 2,
          match.activeSignSprite === 'gol' ? 68 : 74,
        );
      }
    }

    // Banner de festejo de gol con nombre y dorsal del goleador
    if (match.subState === MATCH_SUB_STATE.GOAL_CELEBRATION_BANNER) {
      const scoringTeam = match.lastGoalTeamSide === 1 ? match.teamLeft.data : match.teamRight.data;
      drawStaticSprite(
        ctx,
        this.manifests.sprites,
        this.assets,
        'goalNameBanner',
        0,
        VIRTUAL_WIDTH / 2,
        128,
      );
      drawStaticSprite(
        ctx,
        this.manifests.sprites,
        this.assets,
        'goalNumbersBanner',
        0,
        VIRTUAL_WIDTH / 2,
        174,
      );

      this.fonts.drawText(
        ctx,
        'mediumFont',
        `${scoringTeam.shortName} - GOL!`,
        VIRTUAL_WIDTH / 2,
        120,
        { align: 'center' },
      );
      this.fonts.drawText(
        ctx,
        'bigFont',
        `${match.lastGoalScorerNumber} ${match.lastGoalScorerName.toUpperCase()}`,
        VIRTUAL_WIDTH / 2,
        158,
        { align: 'center' },
      );
    }
  }
}
