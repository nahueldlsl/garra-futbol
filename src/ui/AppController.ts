import { AudioManager } from '../audio/AudioManager';
import {
  GAME_SPEED_SCALES,
  MATCH_DURATION_MINUTES,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
} from '../config/gameConfig';
import { type EventBus, type GlobalAppStateId } from '../core/EventBus';
import { DeterministicRNG } from '../core/RNG';
import { type GameState, StateMachine } from '../core/StateMachine';
import { type AssetManifests, type DataRepository } from '../data/DataRepository';
import type { MenuOption, TeamData } from '../data/types';
import { MatchSimulation } from '../domain/MatchSimulation';
import {
  createMatchSessionState,
  type MatchMode,
  type MatchSessionState,
} from '../entities/MatchState';
import type { TeamControlMode } from '../entities/Team';
import { type InputManager } from '../input/InputManager';
import { AssetLoader } from '../rendering/AssetLoader';
import { MatchRenderer } from '../rendering/MatchRenderer';
import { drawStaticSprite } from '../rendering/SpriteAnimator';

interface ActiveMatchConfig {
  mode: MatchMode;
  cupRound: number;
  leftTeam: TeamData;
  rightTeam: TeamData;
  leftControl: TeamControlMode;
  rightControl: TeamControlMode;
}

/**
 * Controlador principal de aplicación que orquesta las 10 pantallas de `GlobalAppStateId`
 * desacopladas de la simulación pura (`MatchSimulation`).
 */
export class AppController {
  private readonly canvas: HTMLCanvasElement;
  private readonly dataRepo: DataRepository;
  private readonly events: EventBus;
  private readonly input: InputManager;
  private readonly rng = new DeterministicRNG(0x52414747);
  private readonly states = new StateMachine<GlobalAppStateId>();

  private manifests: AssetManifests | null = null;
  private readonly assets = new AssetLoader();
  private audio: AudioManager | null = null;
  private renderer: MatchRenderer | null = null;
  private simulation: MatchSimulation | null = null;

  private loadProgress = 0;
  private loadReady = false;

  // Estado compartido de UI / flujo
  private menuNodeId = 'mainMenu';
  private menuSelectedIndex = 0;
  private logoPhase = 0;
  private logoTimer = 0;

  private helpSlides: string[] = ['help_controles'];
  private helpIndex = 0;
  private creditsScrollY = 0;
  private creditsTick = 0;

  private selectionMode: MatchMode = '1PvsCPU';
  private selectionStep: 1 | 2 = 1;
  private selectionCursor = 0;
  private pickedLeftTeam: TeamData | null = null;
  private pickedRightTeam: TeamData | null = null;
  private winnerDisplayTeam: TeamData | null = null;

  private activeMatchConfig: ActiveMatchConfig | null = null;
  private activeMatch: MatchSessionState | null = null;
  private soccerPauseMenuStage: 'none' | 'main' | 'confirmExit' = 'none';
  private soccerPauseIndex = 0;
  private endMatchOverlayIndex = 0;
  private endMatchCupResultHandled = false;
  private vsTimer = 0;
  private presentationTimer = 0;
  private uiAnimTick = 0;

  constructor(
    canvas: HTMLCanvasElement,
    dataRepo: DataRepository,
    events: EventBus,
    input: InputManager,
  ) {
    this.canvas = canvas;
    this.dataRepo = dataRepo;
    this.events = events;
    this.input = input;

    this.applyCanvasSmoothing();
    this.registerAllStates();
    this.events.on('app:navigate', ({ to }) => {
      this.states.transitionTo(to);
    });
  }

  public start(): void {
    this.states.transitionTo('loading');
    void this.bootstrapAssets();
  }

  public update(dt: number): void {
    this.uiAnimTick += dt * 30;
    this.states.update(dt);
  }

  public render(): void {
    this.states.render();
  }

  public unlockAudio(): void {
    this.audio?.unlock();
  }

  private applyCanvasSmoothing(): void {
    const smooth = this.dataRepo.getOptions().smoothPixels;
    this.canvas.classList.toggle('smooth', smooth);
  }

  private async bootstrapAssets(): Promise<void> {
    const manifests = await this.dataRepo.loadManifests();
    this.manifests = manifests;

    const opts = this.dataRepo.getOptions();
    this.audio = new AudioManager(manifests.audio, this.events, !opts.soundEnabled);
    this.renderer = new MatchRenderer(this.canvas, manifests, this.dataRepo.colors, this.assets);
    this.simulation = new MatchSimulation({
      formationsData: this.dataRepo.formationsData,
      rng: this.rng,
      input: this.input,
      events: this.events,
      speedIndex: opts.speedIndex,
    });

    let imgFrac = 0;
    let audFrac = 0;
    const updateTotal = () => {
      this.loadProgress = imgFrac * 0.75 + audFrac * 0.25;
    };

    await Promise.all([
      this.assets.preloadAll(manifests, (loaded, total) => {
        imgFrac = total > 0 ? loaded / total : 1;
        updateTotal();
      }),
      this.audio.preloadAll((loaded, total) => {
        audFrac = total > 0 ? loaded / total : 1;
        updateTotal();
      }),
    ]);

    this.loadProgress = 1;
    this.loadReady = true;
  }

  private registerAllStates(): void {
    const register = (state: GameState<GlobalAppStateId>) => this.states.register(state);

    register({
      id: 'loading',
      enter: () => {
        this.loadProgress = 0;
        this.loadReady = false;
      },
      update: () => {
        if (this.loadReady) {
          this.states.transitionTo('logo');
        }
      },
      render: () => {
        const ctx = this.getBufferOrDirectContext();
        if (!ctx) return;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);

        if (this.manifests && this.renderer) {
          drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'loading', 0, 0, 0);
          const blocks = Math.round(this.loadProgress * 24);
          for (let i = 0; i < 24; i += 1) {
            const char = i < blocks ? '1' : '0';
            this.renderer.fonts.drawText(ctx, 'loadingBlock', char, 104 + i * 8, 224);
          }
          this.renderer.present(false);
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.font = '14px monospace';
          ctx.fillText('Cargando Garra Fútbol...', 110, 150);
          this.presentFallbackIfNoRenderer(ctx);
        }
      },
    });

    register({
      id: 'logo',
      enter: () => {
        this.logoPhase = 0;
        this.logoTimer = 0;
      },
      update: (dt) => {
        this.logoTimer += dt;
        const skip =
          this.input.getAction('menu', 'accept').justPressed ||
          this.input.getAction('menu', 'shot').justPressed;

        if (this.logoPhase === 0) {
          if (this.logoTimer >= 2.0 || skip) {
            this.logoPhase = 1;
            this.logoTimer = 0;
          }
        } else if (this.logoPhase === 1) {
          if (this.logoTimer >= 2.0 || skip) {
            this.logoPhase = 2;
            this.logoTimer = 0;
            this.events.emit('sound:play', { key: 'introMusic', volumeScale: 1.0 });
          }
        } else {
          if (skip && this.logoTimer > 0.2) {
            this.events.emit('sound:play', { key: 'strongHit', volumeScale: 1.0 });
            this.states.transitionTo('mainMenu');
          }
        }
      },
      render: () => {
        if (!this.manifests || !this.renderer) return;
        const ctx = this.renderer.getVirtualContext();
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);

        if (this.logoPhase === 0) {
          drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'batoviLogo', 0, 0, 0);
        } else if (this.logoPhase === 1) {
          drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'calcarLogo', 0, 0, 0);
        } else {
          drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'garraFutbolLogo', 0, 0, 0);
          if (Math.floor(this.logoTimer * 3) % 2 === 0) {
            drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'pressEnter', 0, 200, 258);
          }
        }
        this.renderer.present(this.dataRepo.getOptions().smoothPixels);
      },
    });

    register({
      id: 'mainMenu',
      enter: () => {
        this.audio?.stop('bgmNormal');
        this.audio?.stop('tribunaNormal');
        this.events.emit('sound:play', { key: 'introMusic', volumeScale: 1.0 });
        this.clampMenuCursor();
      },
      update: () => {
        this.updateMenuNavigation();
      },
      render: () => {
        this.renderMenuScreen();
      },
    });

    register({
      id: 'help',
      enter: () => {
        this.helpIndex = 0;
      },
      update: () => {
        const left = this.input.getAction('menu', 'left').justPressed;
        const right = this.input.getAction('menu', 'right').justPressed;
        const accept =
          this.input.getAction('menu', 'accept').justPressed ||
          this.input.getAction('menu', 'shot').justPressed;
        const cancel = this.input.getAction('menu', 'cancel').justPressed;

        if (left && this.helpSlides.length > 1) {
          this.helpIndex = (this.helpIndex - 1 + this.helpSlides.length) % this.helpSlides.length;
          this.events.emit('sound:play', { key: 'action', volumeScale: 0.9 });
        } else if ((right || accept) && this.helpSlides.length > 1) {
          if (accept && this.helpIndex === this.helpSlides.length - 1) {
            this.events.emit('sound:play', { key: 'strongHit', volumeScale: 1.0 });
            this.states.transitionTo('mainMenu');
            return;
          }
          this.helpIndex = (this.helpIndex + 1) % this.helpSlides.length;
          this.events.emit('sound:play', { key: 'action', volumeScale: 0.9 });
        } else if (cancel || accept) {
          this.events.emit('sound:play', { key: 'strongHit', volumeScale: 1.0 });
          this.states.transitionTo('mainMenu');
        }
      },
      render: () => {
        if (!this.manifests || !this.renderer) return;
        const ctx = this.renderer.getVirtualContext();
        drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'helpBg', 0, 0, 0);
        const slideKey = this.helpSlides[this.helpIndex] ?? 'help_controles';
        drawStaticSprite(
          ctx,
          this.manifests.sprites,
          this.assets,
          slideKey,
          0,
          VIRTUAL_WIDTH / 2,
          VIRTUAL_HEIGHT / 2 - 4,
        );
        if (this.helpSlides.length > 1) {
          this.renderer.fonts.drawText(
            ctx,
            'smallFont',
            `${this.helpIndex + 1}/${this.helpSlides.length}`,
            VIRTUAL_WIDTH / 2,
            274,
            { align: 'center' },
          );
        }
        drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backTip', 0, 42, 286);
        this.renderer.present(this.dataRepo.getOptions().smoothPixels);
      },
    });

    register({
      id: 'credits',
      enter: () => {
        this.creditsScrollY = VIRTUAL_HEIGHT + 16;
        this.creditsTick = 0;
      },
      update: (dt) => {
        this.creditsTick += dt;
        const speedMult =
          this.input.getAction('menu', 'down').isDown ||
          this.input.getAction('menu', 'accept').isDown
            ? 3.2
            : 1.0;
        this.creditsScrollY -= dt * 28 * speedMult;

        if (this.input.getAction('menu', 'cancel').justPressed) {
          this.events.emit('sound:play', { key: 'strongHit', volumeScale: 1.0 });
          this.states.transitionTo('mainMenu');
        }
      },
      render: () => {
        this.renderCreditsScreen();
      },
    });

    register({
      id: 'teamSelection',
      enter: () => {
        this.selectionStep = 1;
        this.selectionCursor = 0;
        this.pickedLeftTeam = null;
        this.pickedRightTeam = null;
      },
      update: () => {
        this.updateTeamSelection();
      },
      render: () => {
        this.renderTeamSelection();
      },
    });

    register({
      id: 'versus',
      enter: () => {
        this.vsTimer = 0;
      },
      update: (dt) => {
        this.vsTimer += dt;
        const confirm =
          this.input.getAction('menu', 'accept').justPressed ||
          this.input.getAction('menu', 'shot').justPressed;
        const cancel = this.input.getAction('menu', 'cancel').justPressed;

        if (cancel && this.selectionMode !== 'CALCAR_CUP') {
          this.states.transitionTo('teamSelection');
          return;
        }
        if ((confirm && this.vsTimer > 0.25) || this.vsTimer >= 3.5) {
          this.events.emit('sound:play', { key: 'strongHit', volumeScale: 1.0 });
          this.states.transitionTo('presentation');
        }
      },
      render: () => {
        this.renderVersusScreen();
      },
    });

    register({
      id: 'presentation',
      enter: () => {
        this.audio?.stop('introMusic');
        this.presentationTimer = 0;
        if (this.activeMatchConfig && this.simulation) {
          const opts = this.dataRepo.getOptions();
          this.activeMatch = createMatchSessionState({
            mode: this.activeMatchConfig.mode,
            cupRound: this.activeMatchConfig.cupRound,
            leftTeam: this.activeMatchConfig.leftTeam,
            rightTeam: this.activeMatchConfig.rightTeam,
            leftControl: this.activeMatchConfig.leftControl,
            rightControl: this.activeMatchConfig.rightControl,
            durationIndex: opts.durationIndex,
          });
          this.simulation.initializeKickOff(this.activeMatch);
        }
        this.events.emit('sound:play', { key: 'bgmNormal', volumeScale: 1.0 });
        this.events.emit('sound:play', { key: 'tribunaNormal', volumeScale: 1.0 });
      },
      update: (dt) => {
        this.presentationTimer += dt;
        const skip =
          this.input.getAction('menu', 'accept').justPressed ||
          this.input.getAction('menu', 'shot').justPressed;
        if (this.presentationTimer >= 1.2 || (skip && this.presentationTimer > 0.2)) {
          this.states.transitionTo('soccer');
        }
      },
      render: () => {
        if (!this.activeMatch || !this.renderer) return;
        const opts = this.dataRepo.getOptions();
        this.renderer.renderMatch(this.activeMatch, opts.smoothPixels, opts.pitchType);
        const ctx = this.renderer.getVirtualContext();
        const header =
          this.activeMatch.mode === 'CALCAR_CUP'
            ? this.dataRepo.getCupRoundLabel(this.activeMatch.cupRound)
            : this.dataRepo.getText('vsAmistoso');
        this.renderer.fonts.drawText(ctx, 'mediumFont', header, VIRTUAL_WIDTH / 2, 108, {
          align: 'center',
        });
        this.renderer.present(opts.smoothPixels);
      },
    });

    register({
      id: 'soccer',
      enter: () => {
        this.soccerPauseMenuStage = 'none';
        this.soccerPauseIndex = 0;
        this.endMatchOverlayIndex = 0;
        this.endMatchCupResultHandled = false;
      },
      update: (dt) => {
        this.updateSoccerState(dt);
      },
      render: () => {
        this.renderSoccerState();
      },
    });

    register({
      id: 'winner',
      enter: () => {
        this.events.emit('sound:play', { key: 'tribuna:ovacion', volumeScale: 1.0 });
      },
      update: () => {
        if (
          this.input.getAction('menu', 'accept').justPressed ||
          this.input.getAction('menu', 'shot').justPressed ||
          this.input.getAction('menu', 'cancel').justPressed
        ) {
          this.menuNodeId = 'mainMenu';
          this.menuSelectedIndex = 0;
          this.states.transitionTo('mainMenu');
        }
      },
      render: () => {
        this.renderWinnerScreen();
      },
    });
  }

  private getVisibleMenuOptions(): MenuOption[] {
    const node =
      this.dataRepo.menuData.nodes[this.menuNodeId] ?? this.dataRepo.menuData.nodes.mainMenu;
    return node.options.filter((opt) => this.dataRepo.isMenuOptionVisible(opt));
  }

  private clampMenuCursor(): void {
    const opts = this.getVisibleMenuOptions();
    if (opts.length === 0) {
      this.menuSelectedIndex = 0;
      return;
    }
    this.menuSelectedIndex = Math.max(0, Math.min(this.menuSelectedIndex, opts.length - 1));
  }

  private updateMenuNavigation(): void {
    const options = this.getVisibleMenuOptions();
    if (options.length === 0) return;

    if (this.input.getAction('menu', 'up').justPressed) {
      this.menuSelectedIndex = (this.menuSelectedIndex - 1 + options.length) % options.length;
      this.events.emit('sound:play', { key: 'action', volumeScale: 1.0 });
    } else if (this.input.getAction('menu', 'down').justPressed) {
      this.menuSelectedIndex = (this.menuSelectedIndex + 1) % options.length;
      this.events.emit('sound:play', { key: 'action', volumeScale: 1.0 });
    }

    if (this.input.getAction('menu', 'cancel').justPressed) {
      const node = this.dataRepo.menuData.nodes[this.menuNodeId];
      if (node?.cancel) {
        const backOption = options.find((o) => o.text === node.cancel);
        if (backOption) {
          this.executeMenuOption(backOption);
          return;
        }
      }
      if (this.menuNodeId !== 'mainMenu') {
        this.menuNodeId = 'mainMenu';
        this.menuSelectedIndex = 0;
        this.clampMenuCursor();
        this.events.emit('sound:play', { key: 'action', volumeScale: 1.0 });
      }
      return;
    }

    if (
      this.input.getAction('menu', 'accept').justPressed ||
      this.input.getAction('menu', 'shot').justPressed
    ) {
      const chosen = options[this.menuSelectedIndex];
      if (chosen) {
        this.executeMenuOption(chosen);
      }
    }
  }

  private executeMenuOption(option: MenuOption): void {
    this.events.emit('sound:play', { key: 'strongHit', volumeScale: 1.0 });

    if (option.link && this.dataRepo.menuData.nodes[option.link]) {
      this.menuNodeId = option.link;
      this.menuSelectedIndex = 0;
      this.clampMenuCursor();
      return;
    }

    const action = option.action;
    if (!action) return;

    if (action === 'gotoCredits') {
      this.states.transitionTo('credits');
      return;
    }
    if (action === 'CalcarCup:continue') {
      const cup = this.dataRepo.getActiveCup();
      if (cup) {
        const playerTeam = this.dataRepo.getTeamById(cup.playerTeamId);
        const oppId = cup.opponentIds[cup.currentRound] ?? cup.opponentIds[0];
        const oppTeam = this.dataRepo.getTeamById(oppId);
        this.selectionMode = 'CALCAR_CUP';
        this.activeMatchConfig = {
          mode: 'CALCAR_CUP',
          cupRound: cup.currentRound,
          leftTeam: playerTeam,
          rightTeam: oppTeam,
          leftControl: 'P1_SOLO',
          rightControl: 'CPU',
        };
        this.states.transitionTo('versus');
      }
      return;
    }
    if (action === 'CalcarCup:startNew:new:confirmNewCup') {
      if (this.dataRepo.getActiveCup() !== null) {
        this.menuNodeId = 'confirmNewCup';
        this.menuSelectedIndex = 0;
        return;
      }
      this.selectionMode = 'CALCAR_CUP';
      this.states.transitionTo('teamSelection');
      return;
    }
    if (action === 'CalcarCup:startNew:confirm') {
      this.selectionMode = 'CALCAR_CUP';
      this.states.transitionTo('teamSelection');
      return;
    }
    if (action === 'CalcarCup:startNew:abort') {
      this.menuNodeId = 'calcarCup';
      this.menuSelectedIndex = 0;
      return;
    }
    if (action.startsWith('startNewExhibition:')) {
      const modeStr = action.slice('startNewExhibition:'.length) as MatchMode;
      this.selectionMode = modeStr;
      this.states.transitionTo('teamSelection');
      return;
    }
    if (action.startsWith('showHelp:')) {
      const slugs = action.slice('showHelp:'.length).split(':').filter(Boolean);
      this.helpSlides = slugs.map((slug) => `help_${slug}`);
      this.states.transitionTo('help');
      return;
    }
    if (action.startsWith('winner:')) {
      const teamId = action.slice('winner:'.length);
      this.winnerDisplayTeam = this.dataRepo.getTeamById(teamId);
      this.states.transitionTo('winner');
      return;
    }
    if (action === 'switch:sound') {
      const next = !this.dataRepo.getOptions().soundEnabled;
      this.dataRepo.updateOptions({ soundEnabled: next });
      this.events.emit('sound:toggleMute', { enabled: next });
      return;
    }
    if (action === 'switch:antialiasing') {
      const next = !this.dataRepo.getOptions().smoothPixels;
      this.dataRepo.updateOptions({ smoothPixels: next });
      this.applyCanvasSmoothing();
      return;
    }
    if (action === 'switch:fullscreenMode') {
      if (typeof document !== 'undefined') {
        if (!document.fullscreenElement) {
          void this.canvas.requestFullscreen?.();
        } else {
          void document.exitFullscreen?.();
        }
      }
      return;
    }
    if (action.startsWith('select:time:')) {
      const mins = Number(action.slice('select:time:'.length));
      const idx = MATCH_DURATION_MINUTES.indexOf(mins as 3 | 6 | 10 | 15);
      if (idx >= 0) {
        this.dataRepo.updateOptions({ durationIndex: idx as 0 | 1 | 2 | 3 });
      }
      this.menuNodeId = 'options';
      this.menuSelectedIndex = 0;
      return;
    }
    if (action.startsWith('select:speed:')) {
      const idx = Number(action.slice('select:speed:'.length));
      if (idx === 0 || idx === 1 || idx === 2 || idx === 3) {
        this.dataRepo.updateOptions({ speedIndex: idx });
        if (this.simulation) {
          // Actualizar multiplicador en vivo
          this.simulation = new MatchSimulation({
            formationsData: this.dataRepo.formationsData,
            rng: this.rng,
            input: this.input,
            events: this.events,
            speedIndex: idx,
          });
        }
      }
      this.menuNodeId = 'options';
      this.menuSelectedIndex = 0;
      return;
    }
    if (action === 'quitGame') {
      this.audio?.stopAll();
      this.menuNodeId = 'mainMenu';
      this.menuSelectedIndex = 0;
      this.states.transitionTo('logo');
    }
  }

  private renderScrollingPattern(
    ctx: CanvasRenderingContext2D,
    patternKey: 'backPattern_blue' | 'backPattern_red',
  ): void {
    if (!this.manifests) return;
    const scrollX = -Math.floor(this.uiAnimTick * 0.4) % 150;
    const scrollY = -Math.floor(this.uiAnimTick * 0.25) % 162;
    for (let x = scrollX - 150; x < VIRTUAL_WIDTH + 150; x += 150) {
      for (let y = scrollY - 162; y < VIRTUAL_HEIGHT + 162; y += 162) {
        drawStaticSprite(ctx, this.manifests.sprites, this.assets, patternKey, 0, x, y);
      }
    }
  }

  private renderMenuScreen(): void {
    if (!this.manifests || !this.renderer) return;
    const ctx = this.renderer.getVirtualContext();
    const opts = this.dataRepo.getOptions();

    // Fondo tileado con patrón rojo en Copa Calcar o azul en menús generales
    const isCupMenu =
      this.menuNodeId.startsWith('calcar') ||
      this.menuNodeId.startsWith('ganadores') ||
      this.menuNodeId === 'confirmNewCup';
    this.renderScrollingPattern(ctx, isCupMenu ? 'backPattern_red' : 'backPattern_blue');

    // Barra superior de estado (`duración`, `velocidad`, `sonido`)
    const mins = MATCH_DURATION_MINUTES[opts.durationIndex];
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'timeIcon', 0, 20, 14);
    this.renderer.fonts.drawText(
      ctx,
      'smallFont',
      `${mins}${this.dataRepo.getText('menuHud_Minutes')}`,
      31,
      9,
    );

    const speedKeys = [
      'gameSpeed_Slow',
      'gameSpeed_Normal',
      'gameSpeed_Fast',
      'gameSpeed_SuperFast',
    ] as const;
    const speedLabel = this.dataRepo.getText(speedKeys[opts.speedIndex] ?? 'gameSpeed_Normal');
    const speedFrame = Math.floor(this.uiAnimTick * GAME_SPEED_SCALES[opts.speedIndex] * 0.4) % 12;
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'speedIcon', speedFrame, 170, 14);
    this.renderer.fonts.drawText(ctx, 'smallFont', speedLabel, 179, 9);

    const soundFrame = opts.soundEnabled ? 0 : 2;
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'soundIcon', soundFrame, 380, 14);

    if (this.menuNodeId !== 'mainMenu') {
      drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backTip', 0, 27, 34);
    }

    // Opciones del nodo activo centradas verticalmente
    const visible = this.getVisibleMenuOptions();
    const rowSpacing = 28;
    const startY = Math.round(148 - ((visible.length - 1) * rowSpacing) / 2);

    for (let i = 0; i < visible.length; i += 1) {
      const opt = visible[i];
      const rowY = startY + i * rowSpacing;
      const isSelected = i === this.menuSelectedIndex;

      drawStaticSprite(
        ctx,
        this.manifests.sprites,
        this.assets,
        'menuSelector',
        isSelected ? 0 : 1,
        VIRTUAL_WIDTH / 2,
        rowY,
      );
      this.renderer.fonts.drawText(
        ctx,
        isSelected ? 'smallFont' : 'smallFontDisabled',
        opt.text,
        VIRTUAL_WIDTH / 2,
        rowY - 5,
        { align: 'center' },
      );
    }

    // Panel informativo inferior y tip de controles del menú
    const selectedOpt = visible[this.menuSelectedIndex];
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'infoPanel', 0, 0, 264);
    if (selectedOpt?.info) {
      this.renderer.fonts.drawText(ctx, 'smallFont', selectedOpt.info, 8, 271, {
        maxWidth: 280,
        lineSpacing: 2,
      });
    }

    const menuTipFrame = Math.floor(this.uiAnimTick / 15) % 4;
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'menuTip', menuTipFrame, 348, 282);

    this.renderer.present(opts.smoothPixels);
  }

  private renderCreditsScreen(): void {
    if (!this.manifests || !this.renderer) return;
    const ctx = this.renderer.getVirtualContext();
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      'creditsBg',
      0,
      VIRTUAL_WIDTH / 2,
      VIRTUAL_HEIGHT / 2,
    );

    let y = this.creditsScrollY;
    for (const entry of this.dataRepo.creditsData.entries) {
      if (entry.type === 'spacer') {
        y += 22;
      } else if (entry.type === 'image') {
        if (y > -64 && y < VIRTUAL_HEIGHT + 64) {
          drawStaticSprite(ctx, this.manifests.sprites, this.assets, entry.spriteKey, 0, 250, y);
        }
        y += 66;
      } else if (entry.type === 'heading') {
        if (y > -24 && y < VIRTUAL_HEIGHT + 24) {
          this.renderer.fonts.drawText(ctx, 'mediumFont', entry.text, VIRTUAL_WIDTH / 2, y, {
            align: 'center',
          });
        }
        y += 22;
      } else {
        const lines = entry.text.split('\n');
        for (const line of lines) {
          if (y > -16 && y < VIRTUAL_HEIGHT + 16) {
            this.renderer.fonts.drawText(ctx, 'smallFont', line, VIRTUAL_WIDTH / 2, y, {
              align: 'center',
            });
          }
          y += 12;
        }
        y += 4;
      }
    }

    if (y < -20) {
      this.creditsScrollY = VIRTUAL_HEIGHT + 16;
    }

    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'creditsFaderTop', 0, 340, 0);
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      'creditsFaderBottom',
      0,
      340,
      VIRTUAL_HEIGHT,
    );
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backTip', 0, 30, 286);

    this.renderer.present(this.dataRepo.getOptions().smoothPixels);
  }

  private updateTeamSelection(): void {
    const teams = this.dataRepo.getTeamsOrdered();
    const total = teams.length;
    if (total === 0) return;

    const cols = 4;
    if (this.input.getAction('menu', 'left').justPressed) {
      this.selectionCursor = (this.selectionCursor - 1 + total) % total;
      this.events.emit('sound:play', { key: 'action', volumeScale: 0.9 });
    } else if (this.input.getAction('menu', 'right').justPressed) {
      this.selectionCursor = (this.selectionCursor + 1) % total;
      this.events.emit('sound:play', { key: 'action', volumeScale: 0.9 });
    } else if (this.input.getAction('menu', 'up').justPressed) {
      this.selectionCursor = (this.selectionCursor - cols + total) % total;
      this.events.emit('sound:play', { key: 'action', volumeScale: 0.9 });
    } else if (this.input.getAction('menu', 'down').justPressed) {
      this.selectionCursor = (this.selectionCursor + cols) % total;
      this.events.emit('sound:play', { key: 'action', volumeScale: 0.9 });
    }

    if (this.input.getAction('menu', 'cancel').justPressed) {
      this.events.emit('sound:play', { key: 'action', volumeScale: 1.0 });
      if (this.selectionStep === 2) {
        this.selectionStep = 1;
        this.pickedRightTeam = null;
      } else {
        this.menuNodeId = this.selectionMode === 'CALCAR_CUP' ? 'calcarCup' : 'exhibition';
        this.menuSelectedIndex = 0;
        this.states.transitionTo('mainMenu');
      }
      return;
    }

    if (
      this.input.getAction('menu', 'accept').justPressed ||
      this.input.getAction('menu', 'shot').justPressed
    ) {
      const selected = teams[this.selectionCursor];
      this.events.emit('sound:play', { key: 'strongHit', volumeScale: 1.0 });

      if (this.selectionMode === 'CALCAR_CUP') {
        const cup = this.dataRepo.startNewCup(selected.id, () => this.rng.nextFloat());
        const opp = this.dataRepo.getTeamById(cup.opponentIds[0]);
        this.activeMatchConfig = {
          mode: 'CALCAR_CUP',
          cupRound: 0,
          leftTeam: selected,
          rightTeam: opp,
          leftControl: 'P1_SOLO',
          rightControl: 'CPU',
        };
        this.states.transitionTo('versus');
        return;
      }

      if (this.selectionStep === 1) {
        this.pickedLeftTeam = selected;
        this.selectionStep = 2;
        this.selectionCursor = (this.selectionCursor + 1) % total;
      } else {
        this.pickedRightTeam = selected;
        const leftTeam = this.pickedLeftTeam ?? teams[0];
        const rightTeam = this.pickedRightTeam;
        const controls: { left: TeamControlMode; right: TeamControlMode } =
          this.selectionMode === '1PvsCPU'
            ? { left: 'P1_SOLO', right: 'CPU' }
            : this.selectionMode === '1Pvs2P'
              ? { left: 'P1_2P', right: 'P2_2P' }
              : { left: 'CPU', right: 'CPU' };

        this.activeMatchConfig = {
          mode: this.selectionMode,
          cupRound: 0,
          leftTeam,
          rightTeam,
          leftControl: controls.left,
          rightControl: controls.right,
        };
        this.states.transitionTo('versus');
      }
    }
  }

  private renderTeamSelection(): void {
    if (!this.manifests || !this.renderer) return;
    const ctx = this.renderer.getVirtualContext();
    const teams = this.dataRepo.getTeamsOrdered();
    const currentTeam = teams[this.selectionCursor] ?? teams[0];
    const isRed = this.selectionStep === 2 || this.selectionMode === 'CALCAR_CUP';

    // 1. Fondo tileado en movimiento (`400x300`)
    this.renderScrollingPattern(ctx, isRed ? 'backPattern_red' : 'backPattern_blue');

    // 2. Barra superior: tecla volver a la izquierda e instrucción alineada a la derecha
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backTip', 0, 27, 14);
    const tipKey =
      this.selectionMode === 'CALCAR_CUP'
        ? 'selectTip_cup'
        : `selectTip_${this.selectionMode}_${this.selectionStep}`;
    this.renderer.fonts.drawText(ctx, 'smallFont', this.dataRepo.getText(tipKey), 390, 8, {
      align: 'right',
    });

    // 3. Panel central (`selectBack_Blue` / `selectBack_Red` en `(0, 62)`)
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      isRed ? 'selectBack_Red' : 'selectBack_Blue',
      0,
      0,
      62,
    );

    // 4. Pedestal y jugador animado sobre la franja izquierda (`0..120`)
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      isRed ? 'selectBase_red' : 'selectBase_blue',
      Math.floor(this.uiAnimTick / 4) % 12,
      60,
      114,
    );

    const previewImg = this.assets.getImage(this.manifests.sprites.sprites.selectedPlayer.path);
    if (previewImg && currentTeam) {
      const recolored = this.renderer.paletteSwapper.getTeamPreviewSheet(
        previewImg,
        'selectedPlayer',
        currentTeam,
      );
      drawStaticSprite(
        ctx,
        this.manifests.sprites,
        this.assets,
        'selectedPlayer',
        Math.floor(this.uiAnimTick / 4) % 12,
        60,
        112,
        { imageOverride: recolored },
      );
    }

    const ballGlyph = this.dataRepo.getText('ball_icon') || 'Ç';

    if (currentTeam) {
      // Nombre del equipo encima del panel derecho
      this.renderer.fonts.drawText(ctx, 'mediumFont', currentTeam.name, 130, 38);

      // Barras con pelota (`Ç`) dentro de la franja izquierda (`y = 129..184`)
      const stats: Array<[string, number]> = [
        [this.dataRepo.getText('stat_attack'), currentTeam.ratings.offense],
        [this.dataRepo.getText('stat_medium'), currentTeam.ratings.middle],
        [this.dataRepo.getText('stat_defense'), currentTeam.ratings.defense],
        [this.dataRepo.getText('stat_goalkeeper'), currentTeam.ratings.goalKeeper],
      ];
      for (let si = 0; si < stats.length; si += 1) {
        const [label, rating] = stats[si];
        const sy = 134 + si * 12;
        const icons = ballGlyph.repeat(Math.max(1, Math.min(5, Math.round(rating))));
        this.renderer.fonts.drawText(ctx, 'smallFont', `${label}${icons}`, 6, sy);
      }

      // Ficha técnica del equipo dentro del panel derecho (`x = 130..392, y = 68..188`)
      const cap = currentTeam.players.find((p) => p.number === currentTeam.captain);
      const captainLabel = this.dataRepo.getText('info_captain');
      this.renderer.fonts.drawText(ctx, 'smallFont', captainLabel, 130, 68);
      this.renderer.fonts.drawText(
        ctx,
        'smallFontEnabled',
        cap?.name ?? '-',
        130 + this.renderer.fonts.measureLineWidth('smallFont', captainLabel),
        68,
      );

      const formattedFormation = currentTeam.formation.split('').join('-');
      this.renderer.fonts.drawText(
        ctx,
        'smallFont',
        `${this.dataRepo.getText('info_formation')}${formattedFormation}`,
        130,
        82,
      );

      let descY = 98;
      const drawDescBlock = (
        fontKey: 'smallFont' | 'smallFontEnabled' | 'smallFontDisabled',
        fullText: string,
      ) => {
        if (!this.renderer) return;
        const lines = this.renderer.fonts.wrapLines(fontKey, fullText, 262);
        this.renderer.fonts.drawText(ctx, fontKey, fullText, 130, descY, {
          maxWidth: 262,
          lineSpacing: 2,
        });
        descY += lines.length * 10 + 4;
      };

      drawDescBlock(
        'smallFont',
        `${this.dataRepo.getText('info_general')}${currentTeam.description.info}`,
      );
      drawDescBlock(
        'smallFontEnabled',
        `${this.dataRepo.getText('info_theGood')}${currentTeam.description.advantages}`,
      );
      drawDescBlock(
        'smallFontDisabled',
        `${this.dataRepo.getText('info_theBad')}${currentTeam.description.disadvantages}`,
      );
    }

    // 5. Grilla 4x4 inferior dentro de `selectPanel` (`192x64` centrado en `(200, 242)`)
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'selectPanel', 0, 200, 242);
    for (let i = 0; i < teams.length; i += 1) {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const colX = 128 + col * 48;
      const rowY = 218 + row * 13;
      const team = teams[i];
      const isFocused = i === this.selectionCursor;
      const isLeftPicked = this.pickedLeftTeam?.id === team.id;

      const fontKey = isFocused
        ? 'smallFont'
        : isLeftPicked
          ? 'smallFontEnabled'
          : 'smallFontDisabled';
      const label = isFocused ? `${ballGlyph}${team.shortName}${ballGlyph}` : team.shortName;
      this.renderer.fonts.drawText(ctx, fontKey, label, colX, rowY, { align: 'center' });
    }

    // 6. Tip animado de controles abajo a la derecha
    const selectTipFrame = Math.floor(this.uiAnimTick / 12) % 6;
    drawStaticSprite(
      ctx,
      this.manifests.sprites,
      this.assets,
      'freeSelectTip',
      selectTipFrame,
      348,
      278,
    );

    this.renderer.present(this.dataRepo.getOptions().smoothPixels);
  }

  private renderVersusScreen(): void {
    if (!this.manifests || !this.renderer || !this.activeMatchConfig) return;
    const ctx = this.renderer.getVirtualContext();
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_blue', 0, 0, 0);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_blue', 0, 150, 0);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_blue', 0, 300, 0);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_blue', 0, 0, 162);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_blue', 0, 150, 162);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_blue', 0, 300, 162);

    const cfg = this.activeMatchConfig;
    const title =
      cfg.mode === 'CALCAR_CUP'
        ? this.dataRepo.getCupRoundLabel(cfg.cupRound)
        : this.dataRepo.getText('vsAmistoso');
    this.renderer.fonts.drawText(ctx, 'mediumFont', title, VIRTUAL_WIDTH / 2, 30, {
      align: 'center',
    });

    this.renderer.fonts.drawText(ctx, 'mediumFont', cfg.leftTeam.name, 96, 86, { align: 'center' });
    this.renderer.fonts.drawText(
      ctx,
      'bigFont',
      this.dataRepo.getText('versus'),
      VIRTUAL_WIDTH / 2,
      134,
      {
        align: 'center',
      },
    );
    this.renderer.fonts.drawText(ctx, 'mediumFont', cfg.rightTeam.name, 304, 86, {
      align: 'center',
    });

    const previewImg = this.assets.getImage(this.manifests.sprites.sprites.selectedPlayer.path);
    if (previewImg) {
      const frame = Math.floor(this.uiAnimTick / 4) % 12;
      drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'selectBase_blue', frame, 96, 198);
      drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'selectBase_red', frame, 304, 198);

      const leftSheet = this.renderer.paletteSwapper.getTeamPreviewSheet(
        previewImg,
        'selectedPlayer',
        cfg.leftTeam,
      );
      const rightSheet = this.renderer.paletteSwapper.getTeamPreviewSheet(
        previewImg,
        'selectedPlayer',
        cfg.rightTeam,
      );
      drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'selectedPlayer', frame, 96, 196, {
        imageOverride: leftSheet,
      });
      drawStaticSprite(
        ctx,
        this.manifests.sprites,
        this.assets,
        'selectedPlayer',
        frame,
        304,
        196,
        {
          imageOverride: rightSheet,
          flipX: true,
        },
      );
    }

    this.renderer.fonts.drawText(
      ctx,
      'smallFont',
      this.dataRepo.getText('pressEnter'),
      VIRTUAL_WIDTH / 2,
      260,
      {
        align: 'center',
      },
    );
    this.renderer.present(this.dataRepo.getOptions().smoothPixels);
  }

  private updateSoccerState(dt: number): void {
    const match = this.activeMatch;
    if (!match || !this.simulation) return;

    if (match.matchFinished) {
      this.updateEndMatchOverlay(match);
      return;
    }

    if (this.input.getAction('menu', 'pause').justPressed) {
      match.paused = !match.paused;
      this.soccerPauseMenuStage = match.paused ? 'main' : 'none';
      this.soccerPauseIndex = 0;
      this.events.emit('sound:play', { key: 'action', volumeScale: 1.0 });
      return;
    }

    if (match.paused) {
      if (
        this.input.getAction('menu', 'up').justPressed ||
        this.input.getAction('menu', 'down').justPressed
      ) {
        this.soccerPauseIndex = 1 - this.soccerPauseIndex;
        this.events.emit('sound:play', { key: 'action', volumeScale: 0.9 });
      }
      if (this.input.getAction('menu', 'cancel').justPressed) {
        if (this.soccerPauseMenuStage === 'confirmExit') {
          this.soccerPauseMenuStage = 'main';
          this.soccerPauseIndex = 0;
        } else {
          match.paused = false;
          this.soccerPauseMenuStage = 'none';
        }
        return;
      }
      if (
        this.input.getAction('menu', 'accept').justPressed ||
        this.input.getAction('menu', 'shot').justPressed
      ) {
        this.events.emit('sound:play', { key: 'strongHit', volumeScale: 1.0 });
        if (this.soccerPauseMenuStage === 'main') {
          if (this.soccerPauseIndex === 0) {
            match.paused = false;
            this.soccerPauseMenuStage = 'none';
          } else {
            this.soccerPauseMenuStage = 'confirmExit';
            this.soccerPauseIndex = 0;
          }
        } else {
          if (this.soccerPauseIndex === 0) {
            this.soccerPauseMenuStage = 'main';
            this.soccerPauseIndex = 0;
          } else {
            this.menuNodeId = 'mainMenu';
            this.menuSelectedIndex = 0;
            this.states.transitionTo('mainMenu');
          }
        }
      }
      return;
    }

    this.simulation.step(match, dt);
  }

  private getEndMatchActions(match: MatchSessionState): Array<{ label: string; action: string }> {
    const leftScore = match.teamLeft.score;
    const rightScore = match.teamRight.score;

    if (match.mode === 'CALCAR_CUP') {
      if (leftScore > rightScore) {
        return [{ label: 'Continuar', action: 'cup_next' }];
      }
      if (leftScore === rightScore) {
        return [
          { label: 'Repetir partido', action: 'again' },
          { label: 'Salir de la copa', action: 'quit' },
        ];
      }
      return [
        { label: 'Reintentar partido', action: 'again' },
        { label: 'Abandonar Copa', action: 'cup_abandon' },
      ];
    }

    return [
      { label: 'Cambiar equipos', action: 'change_teams' },
      { label: 'Repetir', action: 'again' },
      { label: 'Salir', action: 'quit' },
    ];
  }

  private updateEndMatchOverlay(match: MatchSessionState): void {
    if (!this.endMatchCupResultHandled) {
      this.endMatchCupResultHandled = true;
      this.endMatchOverlayIndex = 0;
    }

    const actions = this.getEndMatchActions(match);
    if (this.input.getAction('menu', 'up').justPressed) {
      this.endMatchOverlayIndex = (this.endMatchOverlayIndex - 1 + actions.length) % actions.length;
      this.events.emit('sound:play', { key: 'action', volumeScale: 0.9 });
    } else if (this.input.getAction('menu', 'down').justPressed) {
      this.endMatchOverlayIndex = (this.endMatchOverlayIndex + 1) % actions.length;
      this.events.emit('sound:play', { key: 'action', volumeScale: 0.9 });
    }

    if (
      this.input.getAction('menu', 'accept').justPressed ||
      this.input.getAction('menu', 'shot').justPressed
    ) {
      const picked = actions[this.endMatchOverlayIndex];
      if (!picked) return;
      this.events.emit('sound:play', { key: 'strongHit', volumeScale: 1.0 });

      if (picked.action === 'cup_next') {
        const res = this.dataRepo.advanceCupRound();
        if (res.cupFinished && res.championTeamId) {
          this.winnerDisplayTeam = this.dataRepo.getTeamById(res.championTeamId);
          this.states.transitionTo('winner');
          return;
        }
        const cup = this.dataRepo.getActiveCup();
        if (cup) {
          this.activeMatchConfig = {
            mode: 'CALCAR_CUP',
            cupRound: cup.currentRound,
            leftTeam: this.dataRepo.getTeamById(cup.playerTeamId),
            rightTeam: this.dataRepo.getTeamById(cup.opponentIds[cup.currentRound]),
            leftControl: 'P1_SOLO',
            rightControl: 'CPU',
          };
          this.states.transitionTo('versus');
          return;
        }
      } else if (picked.action === 'cup_abandon') {
        this.dataRepo.abandonCup();
        this.menuNodeId = 'calcarCup';
        this.menuSelectedIndex = 0;
        this.states.transitionTo('mainMenu');
        return;
      } else if (picked.action === 'again') {
        this.states.transitionTo('presentation');
        return;
      } else if (picked.action === 'change_teams') {
        this.states.transitionTo('teamSelection');
        return;
      }

      this.menuNodeId = 'mainMenu';
      this.menuSelectedIndex = 0;
      this.states.transitionTo('mainMenu');
    }
  }

  private renderSoccerState(): void {
    if (!this.activeMatch || !this.renderer || !this.manifests) return;
    const opts = this.dataRepo.getOptions();
    this.renderer.renderMatch(this.activeMatch, opts.smoothPixels, opts.pitchType);
    const ctx = this.renderer.getVirtualContext();

    if (this.activeMatch.paused) {
      drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'pauseBackground', 0, 0, 0, {
        alpha: 0.72,
      });
      const options =
        this.soccerPauseMenuStage === 'main'
          ? [this.dataRepo.getText('pause_continue'), this.dataRepo.getText('pause_exit')]
          : [this.dataRepo.getText('pause_exit_no'), this.dataRepo.getText('pause_exit_yes')];

      this.renderer.fonts.drawText(ctx, 'bigFont', 'PAUSA', VIRTUAL_WIDTH / 2, 76, {
        align: 'center',
      });
      for (let i = 0; i < options.length; i += 1) {
        const y = 136 + i * 28;
        if (i === this.soccerPauseIndex) {
          drawStaticSprite(
            ctx,
            this.manifests.sprites,
            this.assets,
            'menuSelector',
            0,
            VIRTUAL_WIDTH / 2,
            y + 6,
          );
        }
        this.renderer.fonts.drawText(
          ctx,
          i === this.soccerPauseIndex ? 'mediumFont' : 'smallFont',
          options[i],
          VIRTUAL_WIDTH / 2,
          y,
          {
            align: 'center',
          },
        );
      }
    } else if (this.activeMatch.matchFinished) {
      drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'pauseBackground', 0, 0, 0, {
        alpha: 0.78,
      });
      const prefix = this.activeMatch.mode === 'CALCAR_CUP' ? 'calcarCup' : this.activeMatch.mode;
      const outcomeKey =
        this.activeMatch.teamLeft.score > this.activeMatch.teamRight.score
          ? `${prefix}_win`
          : this.activeMatch.teamLeft.score < this.activeMatch.teamRight.score
            ? `${prefix}_fail`
            : `${prefix}_draw`;

      this.renderer.fonts.drawText(
        ctx,
        'bigFont',
        this.dataRepo.getText(outcomeKey),
        VIRTUAL_WIDTH / 2,
        62,
        { align: 'center' },
      );
      this.renderer.fonts.drawText(
        ctx,
        'mediumFont',
        `${this.activeMatch.teamLeft.data.shortName} ${this.activeMatch.teamLeft.score} - ${this.activeMatch.teamRight.score} ${this.activeMatch.teamRight.data.shortName}`,
        VIRTUAL_WIDTH / 2,
        104,
        { align: 'center' },
      );

      const actions = this.getEndMatchActions(this.activeMatch);
      for (let i = 0; i < actions.length; i += 1) {
        const y = 152 + i * 26;
        if (i === this.endMatchOverlayIndex) {
          drawStaticSprite(
            ctx,
            this.manifests.sprites,
            this.assets,
            'menuSelector',
            0,
            VIRTUAL_WIDTH / 2,
            y + 6,
          );
        }
        this.renderer.fonts.drawText(
          ctx,
          i === this.endMatchOverlayIndex ? 'mediumFont' : 'smallFont',
          actions[i].label,
          VIRTUAL_WIDTH / 2,
          y,
          { align: 'center' },
        );
      }
    }

    this.renderer.present(opts.smoothPixels);
  }

  private renderWinnerScreen(): void {
    if (!this.manifests || !this.renderer) return;
    const ctx = this.renderer.getVirtualContext();
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_red', 0, 0, 0);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_red', 0, 150, 0);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_red', 0, 300, 0);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_red', 0, 0, 162);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_red', 0, 150, 162);
    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'backPattern_red', 0, 300, 162);

    this.renderer.fonts.drawText(
      ctx,
      'mediumFont',
      this.dataRepo.getText('CalcarCupVictory'),
      VIRTUAL_WIDTH / 2,
      36,
      { align: 'center' },
    );
    this.renderer.fonts.drawText(
      ctx,
      'bigFont',
      this.winnerDisplayTeam?.name ?? 'CAMPEÓN',
      VIRTUAL_WIDTH / 2,
      74,
      { align: 'center' },
    );

    const previewImg = this.assets.getImage(this.manifests.sprites.sprites.selectedPlayer.path);
    if (previewImg && this.winnerDisplayTeam) {
      const sheet = this.renderer.paletteSwapper.getTeamPreviewSheet(
        previewImg,
        'selectedPlayer',
        this.winnerDisplayTeam,
      );
      const frame = Math.floor(this.uiAnimTick / 4) % 12;
      drawStaticSprite(
        ctx,
        this.manifests.sprites,
        this.assets,
        'selectedPlayer',
        frame,
        VIRTUAL_WIDTH / 2,
        182,
        {
          imageOverride: sheet,
        },
      );
    }

    drawStaticSprite(ctx, this.manifests.sprites, this.assets, 'calcar', 0, VIRTUAL_WIDTH / 2, 224);
    this.renderer.fonts.drawText(
      ctx,
      'mediumFont',
      this.dataRepo.getText('CalcarCupCongrats'),
      VIRTUAL_WIDTH / 2,
      258,
      { align: 'center' },
    );

    this.renderer.present(this.dataRepo.getOptions().smoothPixels);
  }

  private getBufferOrDirectContext(): CanvasRenderingContext2D | null {
    if (this.renderer) {
      return this.renderer.getVirtualContext();
    }
    return this.canvas.getContext('2d');
  }

  private presentFallbackIfNoRenderer(ctx: CanvasRenderingContext2D): void {
    void ctx;
  }
}
