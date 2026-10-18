import { parseFile } from "music-metadata";

/**
 * Обложка из тегов.
 *
 * Из воображаемого «common.picture» извлекается первый jpeg, png или webp.
 * Форматы вроде image/gif или image/tiff в тегах встречаются редко, но с ними нет смысла
 * возиться: для слушалки обложка нужна компактная и в браузере, и мы отдаём
 * то, что нашли, как есть — ресайз позже и по надобности через sharp.
 *
 * Никогда не бросает: отсутствие или битость обложки — не повод отказывать
 * треку, точно так же, как и читка тегов в tags.ts.
 */

export interface Cover {
  /** Байты картинки: из буфера, предоставленного music-metadata. */
  data: Uint8Array;
  mime: string;
  ext: string;
}

const SUPPORTED_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** ext→mime: распознаёт jpg, jpeg, png, webp; остальное octet-stream */
export function coverMime(ext: string): string {
  return EXT_TO_MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

export async function extractCover(path: string): Promise<Cover | null> {
  try {
    const { common } = await parseFile(path);
    const picture = (common.picture ?? []).find((p) => SUPPORTED_EXT[p.format] !== undefined);
    if (!picture) return null;

    const data = picture.data;
    if (!data || data.byteLength === 0) return null;

    return {
      data,
      mime: picture.format,
      ext: SUPPORTED_EXT[picture.format],
    };
  } catch {
    return null;
  }
}
