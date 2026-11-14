import { resolveAssetUrl } from '../config/gameConfig';
import colorsJson from './colors.json';
import creditsJson from './credits.json';
import formationsJson from './formations.json';
import menuJson from './menu.json';
import teamsJson from './teams.json';
import textsJson from './texts.json';
import type {
  AnimatedSpriteManifest,
  AudioManifest,
  ColorsData,
  CreditsData,
  FormationsData,
  FontsManifest,
  MenuData,
  MenuOption,
  SpritesManifest,
  TeamCategory,
  TeamData,
  TeamsData,
  TextsData,
} from './types';

export interface AssetManifests {
  readonly sprites: SpritesManifest;
  readonly fonts: FontsManifest;
  readonly audio: AudioManifest;
  readonly jugador: AnimatedSpriteManifest;
  readonly pelota: AnimatedSpriteManifest;
}

export interface GameOptionsState {
  durationIndex: 0 | 1 | 2 | 3;
  speedIndex: 0 | 1 | 2 | 3;
  soundEnabled: boolean;
  smoothPixels: boolean;
  pitchType: 0 | 1;
}

export interface CalcarCupSave {
  readonly playerTeamId: string;
  readonly opponentIds: readonly string[];
  readonly currentRound: number;
}

export interface PersistedSaveData {
  readonly options: GameOptionsState;
  readonly activeCup: CalcarCupSave | null;
  readonly wonTeams: readonly string[];
}

const SAVE_STORAGE_KEY = 'garra_futbol_save_v1';

const DEFAULT_OPTIONS: GameOptionsState = {
  durationIndex: 1,
  speedIndex: 1,
  soundEnabled: true,
  smoothPixels: false,
  pitchType: 0,
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`No se pudo cargar ${url} (HTTP ${response.status})`);
  }
  return (await response.json()) as T;
}

/**
 * Repositorio central de datos estáticos (`/src/data/*.json`), manifiestos (`/assets/manifests/*.json`)
 * y estado persistido de opciones y Copa Calcar (`localStorage`).
 */
export class DataRepository {
  public readonly colors: ColorsData = colorsJson as unknown as ColorsData;
  public readonly teamsData: TeamsData = teamsJson as unknown as TeamsData;
  public readonly formationsData: FormationsData = formationsJson as unknown as FormationsData;
  public readonly menuData: MenuData = menuJson as unknown as MenuData;
  public readonly textsData: TextsData = textsJson as unknown as TextsData;
  public readonly creditsData: CreditsData = creditsJson as unknown as CreditsData;

  private manifests: AssetManifests | null = null;
  private options: GameOptionsState = { ...DEFAULT_OPTIONS };
  private activeCup: CalcarCupSave | null = null;
  private wonTeams = new Set<string>();

  public constructor() {
    this.loadSave();
  }

  public async loadManifests(): Promise<AssetManifests> {
    if (this.manifests) {
      return this.manifests;
    }
    const [sprites, fonts, audio, jugador, pelota] = await Promise.all([
      fetchJson<SpritesManifest>(resolveAssetUrl('manifests/sprites.json')),
      fetchJson<FontsManifest>(resolveAssetUrl('manifests/fonts.json')),
      fetchJson<AudioManifest>(resolveAssetUrl('manifests/audio.json')),
      fetchJson<AnimatedSpriteManifest>(resolveAssetUrl('manifests/jugador.json')),
      fetchJson<AnimatedSpriteManifest>(resolveAssetUrl('manifests/pelota.json')),
    ]);
    this.manifests = { sprites, fonts, audio, jugador, pelota };
    return this.manifests;
  }

  public getManifests(): AssetManifests {
    if (!this.manifests) {
      throw new Error('Los manifiestos aún no fueron cargados; llamá a loadManifests() primero.');
    }
    return this.manifests;
  }

  public getTeamById(id: string): TeamData {
    const found = this.teamsData.teams.find((team) => team.id === id);
    if (!found) {
      throw new Error(`Equipo inexistente: ${id}`);
    }
    return found;
  }

  public getTeamsOrdered(): readonly TeamData[] {
    return [...this.teamsData.teams].sort((a, b) => a.id.localeCompare(b.id));
  }

  public getText(key: string): string {
    return this.textsData.texts[key]?.text ?? key;
  }

  public getOptions(): Readonly<GameOptionsState> {
    return this.options;
  }

  public updateOptions(patch: Partial<GameOptionsState>): void {
    this.options = { ...this.options, ...patch };
    this.persistSave();
  }

  public getActiveCup(): CalcarCupSave | null {
    return this.activeCup;
  }

  public startNewCup(playerTeamId: string, randomFloat: () => number): CalcarCupSave {
    const others = this.teamsData.teams.filter((t) => t.id !== playerTeamId);
    const byCat = new Map<TeamCategory, TeamData[]>([
      [1, []],
      [2, []],
      [3, []],
      [4, []],
    ]);
    for (const team of others) {
      byCat.get(team.category)?.push(team);
    }
    for (const list of byCat.values()) {
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(randomFloat() * (i + 1));
        const tmp = list[i];
        list[i] = list[j];
        list[j] = tmp;
      }
    }

    const pickFrom = (categories: readonly TeamCategory[], used: Set<string>): TeamData => {
      for (const cat of categories) {
        const list = byCat.get(cat) ?? [];
        for (const candidate of list) {
          if (!used.has(candidate.id)) {
            used.add(candidate.id);
            return candidate;
          }
        }
      }
      const fallback = others.find((t) => !used.has(t.id)) ?? others[0];
      used.add(fallback.id);
      return fallback;
    };

    const usedIds = new Set<string>();
    const scheduleCats: readonly (readonly TeamCategory[])[] = [
      [1, 2],
      [1, 2],
      [2, 1, 3],
      [2, 3, 1],
      [3, 2, 4],
      [4, 3, 2],
      [4, 3],
    ];
    const opponentIds = scheduleCats.map((cats) => pickFrom(cats, usedIds).id);

    this.activeCup = {
      playerTeamId,
      opponentIds,
      currentRound: 0,
    };
    this.persistSave();
    return this.activeCup;
  }

  public advanceCupRound(): { readonly cupFinished: boolean; readonly championTeamId?: string } {
    if (!this.activeCup) {
      return { cupFinished: false };
    }
    const nextRound = this.activeCup.currentRound + 1;
    if (nextRound >= this.activeCup.opponentIds.length) {
      const champion = this.activeCup.playerTeamId;
      this.wonTeams.add(champion);
      this.activeCup = null;
      this.persistSave();
      return { cupFinished: true, championTeamId: champion };
    }
    this.activeCup = {
      ...this.activeCup,
      currentRound: nextRound,
    };
    this.persistSave();
    return { cupFinished: false };
  }

  public abandonCup(): void {
    this.activeCup = null;
    this.persistSave();
  }

  public recordCupWin(teamId: string): void {
    this.wonTeams.add(teamId);
    this.persistSave();
  }

  public hasWonTeam(teamId: string): boolean {
    return this.wonTeams.has(teamId);
  }

  public isMenuOptionVisible(option: MenuOption): boolean {
    const flag = option.condFlag;
    if (!flag) {
      return true;
    }
    if (flag === 'ContinueCalcarCup') {
      return this.activeCup !== null;
    }
    if (flag === 'cupHasBeenWonBefore') {
      return this.wonTeams.size > 0;
    }
    if (flag === 'winOnly') {
      return true;
    }
    if (flag === 'wideScreen') {
      return true;
    }
    if (flag.startsWith('winCategory:')) {
      const targetCat = Number(flag.slice('winCategory:'.length));
      for (const teamId of this.wonTeams) {
        if (this.teamsData.teams.find((t) => t.id === teamId)?.category === targetCat) {
          return true;
        }
      }
      return false;
    }
    if (flag.startsWith('teamWonTheCup:')) {
      const teamId = flag.slice('teamWonTheCup:'.length);
      return this.wonTeams.has(teamId);
    }
    return true;
  }

  public getCupRoundLabel(roundIndex: number): string {
    if (roundIndex <= 2) {
      return `${this.getText('vsCalcarOther')}${roundIndex + 1}`;
    }
    if (roundIndex === 3) {
      return this.getText('vsCalcarOctavos');
    }
    if (roundIndex === 4) {
      return this.getText('vsCalcarCuartos');
    }
    if (roundIndex === 5) {
      return this.getText('vsCalcarSemiFinal');
    }
    return this.getText('vsCalcarFinal');
  }

  private loadSave(): void {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return;
    }
    try {
      const raw = window.localStorage.getItem(SAVE_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<PersistedSaveData>;
      if (parsed.options) {
        this.options = {
          durationIndex: clampIndex(parsed.options.durationIndex, 1),
          speedIndex: clampIndex(parsed.options.speedIndex, 1),
          soundEnabled: parsed.options.soundEnabled ?? true,
          smoothPixels: parsed.options.smoothPixels ?? false,
          pitchType: parsed.options.pitchType === 1 ? 1 : 0,
        };
      }
      if (parsed.activeCup && typeof parsed.activeCup.playerTeamId === 'string') {
        this.activeCup = parsed.activeCup;
      }
      if (Array.isArray(parsed.wonTeams)) {
        this.wonTeams = new Set(parsed.wonTeams.filter((x): x is string => typeof x === 'string'));
      }
    } catch {
      this.options = { ...DEFAULT_OPTIONS };
      this.activeCup = null;
      this.wonTeams.clear();
    }
  }

  private persistSave(): void {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return;
    }
    try {
      const payload: PersistedSaveData = {
        options: this.options,
        activeCup: this.activeCup,
        wonTeams: [...this.wonTeams],
      };
      window.localStorage.setItem(SAVE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignora cuotas o almacenamiento deshabilitado en modo privado.
    }
  }
}

function clampIndex(value: unknown, fallback: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 {
  if (value === 0 || value === 1 || value === 2 || value === 3) {
    return value;
  }
  return fallback;
}
