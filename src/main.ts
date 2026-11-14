import { FIXED_DT } from './config/gameConfig';
import { EventBus } from './core/EventBus';
import { GameLoop } from './core/GameLoop';
import { DataRepository } from './data/DataRepository';
import { InputManager } from './input/InputManager';
import { AppController } from './ui/AppController';

function setupFullscreenButton(canvas: HTMLCanvasElement): void {
  const button = document.getElementById('fullscreen-btn');
  const appRoot = document.getElementById('app');
  if (!(button instanceof HTMLButtonElement) || !(appRoot instanceof HTMLElement)) {
    return;
  }

  if (!document.fullscreenEnabled) {
    button.hidden = true;
    return;
  }

  const syncLabel = (): void => {
    const active = document.fullscreenElement !== null;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.textContent = active ? 'Salir pantalla completa' : 'Pantalla completa';
  };

  button.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      void appRoot.requestFullscreen().catch(() => {
        // Ignorar si el navegador bloquea la solicitud de pantalla completa.
      });
    } else {
      void document.exitFullscreen().catch(() => {
        // Ignorar errores al salir de pantalla completa.
      });
    }
    canvas.focus();
  });

  document.addEventListener('fullscreenchange', syncLabel);
  syncLabel();
}

function bootstrap(): void {
  const canvas = document.getElementById('game-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('No se encontró el elemento #game-canvas');
  }

  const dataRepo = new DataRepository();
  const events = new EventBus();
  const input = new InputManager();
  const controller = new AppController(canvas, dataRepo, events, input);

  input.setInteractionCallback(() => {
    controller.unlockAudio();
  });
  input.attach(window);

  canvas.addEventListener('pointerdown', () => {
    canvas.focus();
    controller.unlockAudio();
  });

  setupFullscreenButton(canvas);

  const loop = new GameLoop({
    fixedTimestep: FIXED_DT,
    onUpdate: (dt) => {
      input.advanceStep(dt);
      controller.update(dt);
    },
    onRender: () => {
      controller.render();
    },
  });

  controller.start();
  loop.start();
}

bootstrap();
