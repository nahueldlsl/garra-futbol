import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIXED_DT } from '../../config/gameConfig';
import { InputManager } from '../InputManager';

describe('InputManager', () => {
  it('normalizes diagonal movement to unit length (1 / sqrt(2))', () => {
    const input = new InputManager();
    input.setVirtualKey('ArrowRight', true);
    input.setVirtualKey('ArrowUp', true);
    input.advanceStep(FIXED_DT);

    const dir = input.getDirection('P1_SOLO');
    assert.ok(Math.abs(dir.x - Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(dir.z + Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(Math.hypot(dir.x, dir.z) - 1) < 1e-6);
  });

  it('tracks justPressed, holdDuration, and justReleased across fixed steps', () => {
    const input = new InputManager();

    input.setVirtualKey('KeyZ', true);
    input.advanceStep(FIXED_DT);
    let shot = input.getAction('P1_SOLO', 'shot');
    assert.equal(shot.isDown, true);
    assert.equal(shot.justPressed, true);
    assert.equal(shot.justReleased, false);
    assert.ok(Math.abs(shot.holdDuration - FIXED_DT) < 1e-9);

    input.advanceStep(FIXED_DT);
    shot = input.getAction('P1_SOLO', 'shot');
    assert.equal(shot.isDown, true);
    assert.equal(shot.justPressed, false);
    assert.ok(Math.abs(shot.holdDuration - FIXED_DT * 2) < 1e-9);

    input.setVirtualKey('KeyZ', false);
    input.advanceStep(FIXED_DT);
    shot = input.getAction('P1_SOLO', 'shot');
    assert.equal(shot.isDown, false);
    assert.equal(shot.justReleased, true);
    assert.ok(Math.abs(shot.holdDuration - FIXED_DT * 2) < 1e-9);
  });

  it('isolates P1_2P and P2_2P profiles on a shared keyboard', () => {
    const input = new InputManager();
    input.setVirtualKey('KeyD', true);
    input.setVirtualKey('KeyQ', true);
    input.setVirtualKey('ArrowLeft', true);
    input.setVirtualKey('Period', true);
    input.advanceStep(FIXED_DT);

    assert.deepEqual(input.getDirection('P1_2P'), { x: 0, z: -1 });
    assert.equal(input.getAction('P1_2P', 'shot').isDown, true);
    assert.deepEqual(input.getDirection('P2_2P'), { x: -1, z: 0 });
    assert.equal(input.getAction('P2_2P', 'shot').isDown, true);

    input.clearAll();
    input.advanceStep(FIXED_DT);
    assert.deepEqual(input.getDirection('P1_2P'), { x: 0, z: 0 });
    assert.equal(input.getAction('P2_2P', 'shot').isDown, false);
  });
});
