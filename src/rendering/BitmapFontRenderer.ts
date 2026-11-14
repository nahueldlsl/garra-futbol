import type { BitmapFontEntry, FontsManifest } from '../data/types';
import type { AssetLoader } from './AssetLoader';

export type TextAlign = 'left' | 'center' | 'right';

export interface DrawTextOptions {
  readonly align?: TextAlign;
  readonly lineSpacing?: number;
  readonly maxWidth?: number;
  readonly alpha?: number;
}

const FALLBACK_CHAR_MAP: Readonly<Record<string, string>> = {
  Á: 'A',
  É: 'E',
  Í: 'I',
  Ó: 'O',
  Ú: 'U',
  Ü: 'U',
  ü: 'u',
  '°': 'º',
  ª: 'º',
};

/**
 * Renderizador de fuentes bitmap pixel-perfect usando `fonts.json`.
 */
export class BitmapFontRenderer {
  private readonly manifest: FontsManifest;
  private readonly assets: AssetLoader;

  constructor(manifest: FontsManifest, assets: AssetLoader) {
    this.manifest = manifest;
    this.assets = assets;
  }

  public getFont(fontKey: string): BitmapFontEntry | undefined {
    return this.manifest.fonts[fontKey];
  }

  public measureLineWidth(fontKey: string, line: string): number {
    const font = this.manifest.fonts[fontKey];
    if (!font) return line.length * 8;
    return line.length * font.advanceX;
  }

  public wrapLines(fontKey: string, text: string, maxWidth?: number): string[] {
    const font = this.manifest.fonts[fontKey];
    const paragraphs = text.split('\n');
    if (!font || !maxWidth || maxWidth <= font.advanceX) {
      return paragraphs;
    }

    const maxChars = Math.max(1, Math.floor(maxWidth / font.advanceX));
    const lines: string[] = [];

    for (const para of paragraphs) {
      if (para.length <= maxChars) {
        lines.push(para);
        continue;
      }
      const words = para.split(' ');
      let current = '';
      for (const word of words) {
        if (!current) {
          current = word;
        } else if (current.length + 1 + word.length <= maxChars) {
          current = `${current} ${word}`;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current) {
        lines.push(current);
      }
    }
    return lines;
  }

  public drawText(
    ctx: CanvasRenderingContext2D,
    fontKey: string,
    text: string,
    x: number,
    y: number,
    options: DrawTextOptions = {},
  ): void {
    const font = this.manifest.fonts[fontKey];
    if (!font) return;
    const sheet = this.assets.getImage(font.path);
    if (!sheet) return;

    const lines = this.wrapLines(fontKey, text, options.maxWidth);
    const align = options.align ?? 'left';
    const lineStep = font.lineHeight + (options.lineSpacing ?? 0);

    const prevAlpha = ctx.globalAlpha;
    if (options.alpha !== undefined) {
      ctx.globalAlpha = prevAlpha * options.alpha;
    }

    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      const lineWidth = line.length * font.advanceX;
      let cursorX = Math.round(x);
      if (align === 'center') {
        cursorX = Math.round(x - lineWidth / 2);
      } else if (align === 'right') {
        cursorX = Math.round(x - lineWidth);
      }
      const cursorY = Math.round(y + li * lineStep);

      for (let ci = 0; ci < line.length; ci += 1) {
        const rawChar = line[ci];
        const ch = font.glyphs[rawChar] ? rawChar : (FALLBACK_CHAR_MAP[rawChar] ?? rawChar);
        const glyph = font.glyphs[ch];
        if (glyph && ch !== ' ') {
          ctx.drawImage(
            sheet,
            glyph.x,
            glyph.y,
            glyph.w,
            glyph.h,
            cursorX,
            cursorY,
            glyph.w,
            glyph.h,
          );
        }
        cursorX += font.advanceX;
      }
    }

    ctx.globalAlpha = prevAlpha;
  }
}
