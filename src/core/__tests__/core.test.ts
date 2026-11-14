import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventBus } from '../EventBus';
import { DeterministicRNG } from '../RNG';
import { StateMachine } from '../StateMachine';

describe('EventBus', () => {
  it('delivers typed payloads and supports unsubscription', () => {
    const bus = new EventBus();
    const calls: string[] = [];

    const unsub = bus.on('sound:play', ({ key, volumeScale }) => {
      calls.push(`${key}:${volumeScale ?? 1}`);
    });

    bus.emit('sound:play', { key: 'kick', volumeScale: 0.5 });
    unsub();
    bus.emit('sound:play', { key: 'goal' });

    assert.deepEqual(calls, ['kick:0.5']);
  });

  it('clears all registered listeners', () => {
    const bus = new EventBus();
    let count = 0;
    bus.on('app:navigate', () => {
      count += 1;
    });
    bus.clear();
    bus.emit('app:navigate', { to: 'mainMenu' });
    assert.equal(count, 0);
  });
});

describe('StateMachine', () => {
  it('invokes exit and enter hooks with previous and next state ids', () => {
    const log: string[] = [];
    const sm = new StateMachine<'a' | 'b'>();

    sm.register({
      id: 'a',
      enter: (prev) => log.push(`enter:a:${prev ?? 'none'}`),
      update: (dt) => log.push(`update:a:${dt}`),
      render: () => log.push('render:a'),
      exit: (next) => log.push(`exit:a:${next ?? 'none'}`),
    });

    sm.register({
      id: 'b',
      enter: (prev) => log.push(`enter:b:${prev ?? 'none'}`),
      update: (dt) => log.push(`update:b:${dt}`),
      render: () => log.push('render:b'),
    });

    sm.transitionTo('a');
    sm.update(0.5);
    sm.render();
    sm.transitionTo('b');
    sm.update(0.25);

    assert.equal(sm.getCurrentId(), 'b');
    assert.equal(sm.getCurrentState()?.id, 'b');
    assert.deepEqual(log, [
      'enter:a:none',
      'update:a:0.5',
      'render:a',
      'exit:a:b',
      'enter:b:a',
      'update:b:0.25',
    ]);
  });

  it('throws when transitioning to an unregistered state', () => {
    const sm = new StateMachine<'loading' | 'mainMenu'>();
    assert.throws(() => sm.transitionTo('mainMenu'), /Estado no registrado/);
  });
});

describe('DeterministicRNG', () => {
  it('produces identical sequences for the same seed', () => {
    const rngA = new DeterministicRNG(12345);
    const rngB = new DeterministicRNG(12345);

    const seqA = Array.from({ length: 10 }, () => rngA.nextInt());
    const seqB = Array.from({ length: 10 }, () => rngB.nextInt());
    assert.deepEqual(seqA, seqB);

    rngA.setSeed(12345);
    assert.equal(rngA.getSeed(), 12345);
    assert.equal(rngA.nextInt(), seqB[0]);
  });

  it('respects range bounds and deterministic pick', () => {
    const rng = new DeterministicRNG(42);
    for (let i = 0; i < 50; i += 1) {
      const f = rng.nextFloat();
      assert.ok(f >= 0 && f < 1);
      const r = rng.range(10, 20);
      assert.ok(r >= 10 && r < 20);
      const s = rng.signedNormalized();
      assert.ok(s >= -1 && s <= 1);
    }

    const picked = rng.pick(['x', 'y', 'z'] as const);
    assert.ok(['x', 'y', 'z'].includes(picked));
    assert.throws(() => rng.pick([]), /arreglo no vacío/);
  });
});
