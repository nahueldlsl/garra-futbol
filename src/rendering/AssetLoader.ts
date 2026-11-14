import { resolveAssetUrl } from '../config/gameConfig';
import type { AssetManifests } from '../data/DataRepository';

/**
 * Cargador y caché central de imágenes (`/public/assets/`) para renderizado Canvas 2D.
 */
export class AssetLoader {
  private readonly images = new Map<string, HTMLImageElement>();

  public async preloadAll(
    manifests: AssetManifests,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<void> {
    const pathSet = new Set<string>();

    for (const sprite of Object.values(manifests.sprites.sprites)) {
      pathSet.add(sprite.path);
    }
    for (const font of Object.values(manifests.fonts.fonts)) {
      pathSet.add(font.path);
    }
    pathSet.add(manifests.jugador.imagePath);
    pathSet.add(manifests.pelota.imagePath);

    const paths = [...pathSet];
    const total = paths.length;
    let loaded = 0;

    await Promise.all(
      paths.map(async (relPath) => {
        try {
          const img = await this.loadSingle(relPath);
          this.images.set(relPath, img);
        } catch {
          // Mantener tolerancia ante assets opcionales faltantes
        } finally {
          loaded += 1;
          onProgress?.(loaded, total);
        }
      }),
    );
  }

  private loadSingle(relPath: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`No se pudo cargar imagen: ${relPath}`));
      img.src = resolveAssetUrl(relPath);
    });
  }

  public getImage(relPath: string): HTMLImageElement | undefined {
    return this.images.get(relPath);
  }
}
