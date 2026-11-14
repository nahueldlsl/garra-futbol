/**
 * Generador pseudoaleatorio determinista compatible con LCG de `msvcrt` (`rand()`).
 */
export class DeterministicRNG {
  private state: number;

  public constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  public getSeed(): number {
    return this.state;
  }

  public setSeed(seed: number): void {
    this.state = seed >>> 0;
  }

  /** Retorna entero en `[0, 32767]` siguiendo `(state * 214013 + 2531011) >>> 16 & 0x7fff`. */
  public nextInt(): number {
    this.state = (Math.imul(this.state, 214013) + 2531011) >>> 0;
    return (this.state >>> 16) & 0x7fff;
  }

  /** Retorna flotante uniforme en `[0, 1)`. */
  public nextFloat(): number {
    return this.nextInt() / 32768;
  }

  /** Retorna flotante en `[min, max)`. */
  public range(min: number, max: number): number {
    return min + (max - min) * this.nextFloat();
  }

  /** Retorna flotante normalizado con signo en `[-1, 1]`. */
  public signedNormalized(): number {
    return this.nextInt() / 16383.5 - 1;
  }

  /** Selecciona un elemento de un arreglo no vacío de forma determinista. */
  public pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('DeterministicRNG.pick requiere un arreglo no vacío');
    }
    const index = this.nextInt() % items.length;
    return items[index];
  }
}
