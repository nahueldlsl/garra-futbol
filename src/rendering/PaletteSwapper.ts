import type {
  ColorsData,
  OriginalColorSlot,
  PaletteEntry,
  PlayerData,
  TeamData,
} from '../data/types';

interface SlotToneTarget {
  readonly slot: OriginalColorSlot;
  readonly tone: 'c1' | 'c2';
}

function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

/**
 * Realiza palette-swap pixel-perfect de los 7 pares `(c1, c2)` de `colors.json`
 * (`hair`, `skin`, `eyes`, `tShirt`, `short`, `tights`, `gloves`) y los cachea.
 */
export class PaletteSwapper {
  private readonly colors: ColorsData;
  private readonly originalLookup = new Map<number, SlotToneTarget>();
  private readonly cache = new Map<string, HTMLCanvasElement>();

  constructor(colors: ColorsData) {
    this.colors = colors;
    const slots: readonly OriginalColorSlot[] = [
      'hair',
      'skin',
      'eyes',
      'tShirt',
      'short',
      'tights',
      'gloves',
    ];
    for (const slot of slots) {
      const entry = colors.originalColors[slot];
      this.originalLookup.set(packRgb(entry.c1.r, entry.c1.g, entry.c1.b), { slot, tone: 'c1' });
      this.originalLookup.set(packRgb(entry.c2.r, entry.c2.g, entry.c2.b), { slot, tone: 'c2' });
    }
  }

  public getPlayerSheet(
    sourceImage: HTMLImageElement,
    sourceId: string,
    team: TeamData,
    player: PlayerData,
  ): HTMLCanvasElement {
    const isGk = player.number === 1;
    const shirtKey = isGk ? team.colors.goalKeeperTshirt : team.colors.tshirt;
    const shortKey = isGk ? team.colors.goalKeeperShort : team.colors.short;
    const socksKey = isGk ? team.colors.goalKeeperSocks : team.colors.socks;
    const glovesKey = isGk ? team.colors.goalKeeperGloves : player.skin;

    const cacheKey = `${sourceId}|${player.hair}|${player.skin}|${player.eyes}|${shirtKey}|${shortKey}|${socksKey}|${glovesKey}`;
    const existing = this.cache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const slotEntries: Record<OriginalColorSlot, PaletteEntry> = {
      hair: this.colors.hairColors[player.hair] ?? this.colors.originalColors.hair,
      skin: this.colors.skinColors[player.skin] ?? this.colors.originalColors.skin,
      eyes: this.colors.eyeColors[player.eyes] ?? this.colors.originalColors.eyes,
      tShirt: this.colors.basicColors[shirtKey] ?? this.colors.originalColors.tShirt,
      short: this.colors.basicColors[shortKey] ?? this.colors.originalColors.short,
      tights: this.colors.basicColors[socksKey] ?? this.colors.originalColors.tights,
      gloves: isGk
        ? (this.colors.basicColors[glovesKey] ?? this.colors.originalColors.gloves)
        : (this.colors.skinColors[player.skin] ?? this.colors.originalColors.skin),
    };

    const recolored = this.buildRecoloredCanvas(sourceImage, slotEntries);
    this.cache.set(cacheKey, recolored);
    return recolored;
  }

  public getTeamPreviewSheet(
    sourceImage: HTMLImageElement,
    sourceId: string,
    team: TeamData,
  ): HTMLCanvasElement {
    const representative =
      team.players.find((p) => p.number === team.captain) ?? team.players[9] ?? team.players[0];
    return this.getPlayerSheet(sourceImage, sourceId, team, {
      ...representative,
      number: representative.number === 1 ? 10 : representative.number,
    });
  }

  private buildRecoloredCanvas(
    sourceImage: HTMLImageElement,
    slotEntries: Record<OriginalColorSlot, PaletteEntry>,
  ): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = sourceImage.naturalWidth || sourceImage.width;
    canvas.height = sourceImage.naturalHeight || sourceImage.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    ctx.drawImage(sourceImage, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) continue;

      const target = this.originalLookup.get(packRgb(data[i], data[i + 1], data[i + 2]));
      if (!target) continue;

      const paletteEntry = slotEntries[target.slot];
      const replacement = target.tone === 'c1' ? paletteEntry.c1 : paletteEntry.c2;
      data[i] = replacement.r;
      data[i + 1] = replacement.g;
      data[i + 2] = replacement.b;
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }
}
