/**
 * Tipos estrictos para los manifiestos de assets (`/public/assets/manifests/*.json`)
 * y tablas de datos (`/src/data/*.json`) extraídos de Garra Fútbol.
 */

export interface Size2D {
  readonly w: number;
  readonly h: number;
}

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface Offset2D {
  readonly dx: number;
  readonly dy: number;
}

export interface Rect2D {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type ColorMode = 'RGB' | 'RGBA';

/* ============================================================================
 * Manifiestos de sprites animados (`jugador.json` y `pelota.json`)
 * ========================================================================== */

export type FlipMode = 'NONE' | 'H' | 'V' | 'HV';

export interface AtlasFrameEntry {
  readonly index: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly regX: number;
  readonly regY: number;
  readonly contentBbox: Rect2D | null;
}

export interface FgtImageEntry {
  readonly index: number;
  readonly groupId: number;
  readonly frameIndex: number;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly rect: Rect2D;
}

export interface AnimationFrameStep {
  readonly groupId: number;
  readonly frameIndex: number;
  readonly offset: Offset2D;
  readonly ticks: number;
  readonly flip: FlipMode;
  readonly scaleX: 1 | -1;
  readonly scaleY: 1 | -1;
}

export interface SpriteAnimation {
  readonly id: number;
  readonly loop: boolean;
  readonly loopFrameRaw: number;
  readonly loopFrameIndex: number | null;
  readonly totalTicks: number;
  readonly frames: readonly AnimationFrameStep[];
}

export interface AnimatedSpriteManifest {
  readonly name: string;
  readonly imagePath: string;
  readonly textureSize: Size2D;
  readonly defaultReg: Point2D;
  readonly atlasFrames: readonly AtlasFrameEntry[];
  readonly fgtImages: readonly FgtImageEntry[];
  readonly animations: readonly SpriteAnimation[];
}

/* ============================================================================
 * Manifiesto general de sprites (`sprites.json`)
 * ========================================================================== */

export type SpriteMode = 0 | 1 | 2 | 3 | 4;
export type PivotMode = 'center' | 'explicit';

export interface SpriteFrame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly contentBbox: Rect2D | null;
}

export interface SpriteEntry {
  readonly path: string;
  readonly originalColorMode: ColorMode;
  readonly textureSize: Size2D;
  readonly mode: SpriteMode;
  readonly pivotMode: PivotMode;
  readonly frames: readonly SpriteFrame[];
  readonly notes?: string;
}

export interface SpritesManifest {
  readonly virtualResolution: Size2D;
  readonly sprites: Readonly<Record<string, SpriteEntry>>;
}

/* ============================================================================
 * Manifiesto de fuentes bitmap (`fonts.json`)
 * ========================================================================== */

export interface FontGlyphEntry {
  readonly index: number;
  readonly codePoint: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly contentBbox: Rect2D | null;
}

export interface BitmapFontEntry {
  readonly path: string;
  readonly originalColorMode: ColorMode;
  readonly textureSize: Size2D;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly advanceX: number;
  readonly lineHeight: number;
  readonly cols: number;
  readonly rows: number;
  readonly glyphCount: number;
  readonly glyphs: Readonly<Record<string, FontGlyphEntry>>;
  readonly binarySpriteCropNote?: string;
}

export interface FontsManifest {
  readonly glyphOrder: readonly string[];
  readonly fonts: Readonly<Record<string, BitmapFontEntry>>;
}

/* ============================================================================
 * Manifiesto de audio (`audio.json`)
 * ========================================================================== */

export type AudioCategory = 'music' | 'sfx';

export interface AudioEntry {
  readonly path: string;
  readonly category: AudioCategory;
  readonly defaultVolume: number;
  readonly loop: boolean;
  readonly sizeBytes: number;
}

export interface AudioManifest {
  readonly sounds: Readonly<Record<string, AudioEntry>>;
}

/* ============================================================================
 * Paletas y colores (`src/data/colors.json`)
 * ========================================================================== */

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly hex: string;
}

export interface PaletteEntry {
  readonly index: number;
  readonly name: string;
  readonly c1: RgbColor;
  readonly c2: RgbColor;
}

export type OriginalColorSlot = 'hair' | 'skin' | 'eyes' | 'tShirt' | 'short' | 'tights' | 'gloves';

export interface ColorsData {
  readonly fixedColors: {
    readonly outline: string;
    readonly shoeDetail: string;
    readonly eyeSclera: string;
  };
  readonly originalColors: Readonly<Record<OriginalColorSlot, PaletteEntry>>;
  readonly hairColors: Readonly<Record<string, PaletteEntry>>;
  readonly skinColors: Readonly<Record<string, PaletteEntry>>;
  readonly eyeColors: Readonly<Record<string, PaletteEntry>>;
  readonly basicColors: Readonly<Record<string, PaletteEntry>>;
}

/* ============================================================================
 * Equipos, jugadores y formaciones (`teams.json` y `formations.json`)
 * ========================================================================== */

export type FormationId = '442' | '433' | '352';
export type TeamCategory = 1 | 2 | 3 | 4;

export interface TeamColors {
  readonly tshirt: string;
  readonly short: string;
  readonly socks: string;
  readonly goalKeeperTshirt: string;
  readonly goalKeeperShort: string;
  readonly goalKeeperSocks: string;
  readonly goalKeeperGloves: string;
}

export interface TeamDescription {
  readonly info: string;
  readonly advantages: string;
  readonly disadvantages: string;
}

export interface TeamRatings {
  readonly offense: number;
  readonly middle: number;
  readonly defense: number;
  readonly goalKeeper: number;
}

export interface PlayerData {
  readonly number: number;
  readonly id: string;
  readonly name: string;
  readonly hair: string;
  readonly skin: string;
  readonly eyes: string;
  readonly skill: number;
  readonly speed: number;
  readonly marking: number;
  readonly drivingFail: number;
  readonly block: number;
  readonly power: number;
  readonly inaccuracy: number;
}

export interface TeamData {
  readonly id: string;
  readonly category: TeamCategory;
  readonly name: string;
  readonly shortName: string;
  readonly captain: number;
  readonly formation: FormationId;
  readonly colors: TeamColors;
  readonly description: TeamDescription;
  readonly ratings: TeamRatings;
  readonly players: readonly PlayerData[];
}

export interface TeamsData {
  readonly teams: readonly TeamData[];
}

export interface OutfieldPosition {
  readonly playerNumber: number;
  readonly x: number;
  readonly y: number;
}

export interface FormationDefinition {
  readonly id: FormationId;
  readonly goalkeeperNumber: 1;
  readonly outfieldPositions: readonly OutfieldPosition[];
}

export interface FormationsData {
  readonly formations: Readonly<Record<FormationId, FormationDefinition>>;
}

/* ============================================================================
 * Menús, textos localizados y créditos (`menu.json`, `texts.json`, `credits.json`)
 * ========================================================================== */

export interface MenuOption {
  readonly tag: string;
  readonly text: string;
  readonly rawText: string;
  readonly info: string;
  readonly link?: string;
  readonly action?: string;
  readonly condFlag?: string;
}

export interface MenuNode {
  readonly id: string;
  readonly cancel?: string;
  readonly options: readonly MenuOption[];
}

export interface MenuData {
  readonly rootMenuId: string;
  readonly nodeOrder: readonly string[];
  readonly nodes: Readonly<Record<string, MenuNode>>;
}

export interface TextEntry {
  readonly text: string;
  readonly raw: string;
}

export interface TextsData {
  readonly texts: Readonly<Record<string, TextEntry>>;
}

export type CreditEntry =
  | { readonly type: 'spacer' }
  | { readonly type: 'image'; readonly spriteKey: string }
  | { readonly type: 'heading'; readonly text: string; readonly raw: string }
  | { readonly type: 'text'; readonly text: string; readonly raw: string };

export interface CreditsData {
  readonly entries: readonly CreditEntry[];
}
