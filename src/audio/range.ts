/**
 * Разбор заголовка Range для отдачи аудио кусками.
 *
 * Без Range браузер не умеет перематывать <audio>: он скачивает файл целиком,
 * чтобы найти нужный момент. С Range приходит только запрошенный кусок, и
 * перемотка становится мгновенной.
 */

/** Полуинтервал байтов, обе границы включительно. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Что делать с запросом:
 *  — `null` — отдать файл целиком с кодом 200;
 *  — `"unsatisfiable"` — диапазон за пределами файла, ответить 416;
 *  — объект — отдать кусок с кодом 206.
 */
export type RangeResult = ByteRange | "unsatisfiable" | null;

/**
 * Разбирает `Range: bytes=...`.
 *
 * Неразбираемый заголовок и несколько диапазонов трактуются как «отдай целиком»:
 * по спецификации сервер вправе проигнорировать Range, и это лучше, чем 416 на
 * запрос, который на самом деле корректный.
 */
export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return null;

  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return null;

  const spec = match[1].trim();
  // Несколько диапазонов через запятую не поддерживаем: multipart/byteranges
  // ради одного трека — лишняя сложность без выигрыша.
  if (spec.includes(",")) return null;

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return null;
  const [, rawStart, rawEnd] = parts;

  // «bytes=-» без числа с обеих сторон — бессмыслица.
  if (rawStart === "" && rawEnd === "") return null;
  if (size === 0) return "unsatisfiable";

  // bytes=-N — последние N байтов.
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    // Запросили больше, чем есть: отдаём весь файл.
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";

  // bytes=N- — от N до конца файла.
  if (rawEnd === "") return { start, end: size - 1 };

  const end = Number(rawEnd);
  if (end < start) return "unsatisfiable";
  // Правую границу за пределами файла обрезаем, а не отвергаем: клиент мог
  // запросить с запасом.
  return { start, end: Math.min(end, size - 1) };
}
