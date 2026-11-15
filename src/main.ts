import { FIXED_DT } from './config/gameConfig';
import { EventBus } from './core/EventBus';
import { GameLoop } from './core/GameLoop';
import { DataRepository } from './data/DataRepository';
import { InputManager } from './input/InputManager';
import { AppController } from './ui/AppController';

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
