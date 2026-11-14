import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DeterministicRNG } from '../../core/RNG';
import { DataRepository } from '../DataRepository';

class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>();

  public get length(): number {
    return this.store.size;
  }

  public clear(): void {
    this.store.clear();
  }

  public getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.store.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const originalWindow = (globalThis as { window?: unknown }).window;

describe('DataRepository', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    (globalThis as { window: { localStorage: Storage } }).window = {
      localStorage: storage,
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('persists game options and restores safely from corrupted storage', () => {
    const repo = new DataRepository();
    assert.equal(repo.getOptions().durationIndex, 1);
    assert.equal(repo.getOptions().soundEnabled, true);

    repo.updateOptions({ durationIndex: 3, soundEnabled: false, pitchType: 1 });

    const reloaded = new DataRepository();
    assert.equal(reloaded.getOptions().durationIndex, 3);
    assert.equal(reloaded.getOptions().soundEnabled, false);
    assert.equal(reloaded.getOptions().pitchType, 1);

    storage.setItem('garra_futbol_save_v1', '{invalid-json');
    const resilient = new DataRepository();
    assert.equal(resilient.getOptions().durationIndex, 1);
    assert.equal(resilient.getActiveCup(), null);
  });

  it('runs a 7-round Copa Calcar campaign and unlocks winner flags', () => {
    const repo = new DataRepository();
    const teams = repo.getTeamsOrdered();
    assert.equal(teams.length, 16);

    const rng = new DeterministicRNG(77);
    const playerTeam = teams[0];
    const cup = repo.startNewCup(playerTeam.id, () => rng.nextFloat());

    assert.equal(cup.playerTeamId, playerTeam.id);
    assert.equal(cup.opponentIds.length, 7);
    assert.equal(new Set(cup.opponentIds).size, 7);
    assert.ok(!cup.opponentIds.includes(playerTeam.id));

    const continueOpt = repo.menuData.nodes.calcarCup.options.find(
      (opt) => opt.condFlag === 'ContinueCalcarCup',
    );
    const winnersOpt = repo.menuData.nodes.calcarCup.options.find(
      (opt) => opt.condFlag === 'cupHasBeenWonBefore',
    );
    assert.ok(continueOpt && repo.isMenuOptionVisible(continueOpt));
    assert.ok(winnersOpt && !repo.isMenuOptionVisible(winnersOpt));

    for (let round = 0; round < 6; round += 1) {
      const step = repo.advanceCupRound();
      assert.equal(step.cupFinished, false);
    }

    const finalResult = repo.advanceCupRound();
    assert.equal(finalResult.cupFinished, true);
    assert.equal(finalResult.championTeamId, playerTeam.id);
    assert.equal(repo.hasWonTeam(playerTeam.id), true);
    assert.equal(repo.getActiveCup(), null);
    assert.ok(winnersOpt && repo.isMenuOptionVisible(winnersOpt));
    assert.ok(
      repo.isMenuOptionVisible({
        tag: 'test',
        text: 'test',
        rawText: 'test',
        info: '',
        condFlag: `teamWonTheCup:${playerTeam.id}`,
      }),
    );
  });

  it('formats Copa Calcar round labels and retrieves known teams', () => {
    const repo = new DataRepository();
    const batovi = repo.getTeamById('M_batoviFC');
    assert.equal(batovi.name, 'Batovi FC');
    assert.throws(() => repo.getTeamById('non_existent'), /Equipo inexistente/);
    assert.ok(repo.getCupRoundLabel(0).endsWith('1'));
    assert.ok(repo.getCupRoundLabel(6).length > 0);
  });
});
