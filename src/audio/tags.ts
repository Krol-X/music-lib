import { parseFile } from "music-metadata";
import type { ICommonTagsResult } from "music-metadata";

/**
 * Теги из файла, приведённые к виду, пригодному для строки в БД.
 *
 * Практика показала, что доверять тегам в исходном виде нельзя: genre
 * приходит массивом, artist строкой, рядом с ним второй массив artists, год
 * числом, а рядом с ним строка date, и примерно половина полей у настоящих
 * файлов отсутствует целиком. Поэтому всё приводится к плоскому набору, где
 * каждый столбец либо строка, либо null.
 */
export interface TrackTags {
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  trackNo: number | null;
  trackTotal: number | null;
  discNo: number | null;
  discTotal: number | null;
}

export const EMPTY_TAGS: TrackTags = {
  title: null,
  artist: null,
  album: null,
  genre: null,
  year: null,
  trackNo: null,
  trackTotal: null,
  discNo: null,
  discTotal: null,
};

/**
 * Потолок длины текстового тега. У настоящих файлов превышение не встречается,
 * но битый тег в 300 кБайт — это реальность, и такой текст в базе не нужен.
 */
const MAX_TEXT = 1000;

/**
 * Список значений в одну строку. Хранить массивом в SQLite без второй таблицы
 * бессмысленно, а порядок в теге значим: первый — основной исполнитель.
 * Разбиение по нескольким исполнителям в отдельную таблицу — задача на потом.
 */
const JOIN = ", ";

/**
 * Починка кириллицы из тегов без UTF-8. ID3v2 с encoding=0 (обещан
 * ISO-8859-1) и ID3v1 в реальности почти всегда писались в windows-1251:
 * парсер честно верит заголовку, и «Ругань Из-За Стены» приезжает как
 * «Ðóãàíü Èç-Çà Ñòåíû».
 *
 * Чиним только если строка в этом и нуждается: единичные «декоративные»
 * латинские буквы из этого диапазона (Björk, Motörhead) не должны
 * превращаться в кириллицу. Порог 60% «наших» букв после перекодировки —
 * mojibake от русского текста даёт под 100%, а у родного латинского
 * заголовка руки до 1-2 знаков, то есть сильно меньше порога.
 */
export function repairCyrillic(s: string): string {
  if (!/[\xC0-\xFF]/.test(s)) return s;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from([...s], (ch) => {
      const code = ch.codePointAt(0)!;
      return code <= 0xFF ? code : 0x3F; // кириллица из UTF-8 мимо байта — не его случай
    });
  } catch {
    return s;
  }
  let repaired: string;
  try {
    repaired = new TextDecoder("windows-1251").decode(bytes);
  } catch {
    return s;
  }
  const cyr = (repaired.match(/[\u0400-\u04FF]/g) ?? []).length;
  const letters = (repaired.match(/[A-Za-z\u0400-\u04FF]/g) ?? []).length;
  return letters > 0 && cyr / letters >= 0.6 ? repaired : s;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\0/g, "").trim();
  return trimmed === "" ? null : repairCyrillic(trimmed).slice(0, MAX_TEXT);
}

function joinList(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value.map(text).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(JOIN) : null;
  }
  return text(value);
}

/**
 * Год: сначала поле year, которое music-metadata уже распарсил, иначе первые
 * четыре цифры из date. Дата в тегах встречается в форматах от "1973" до
 * "1973-06-01T00:00:00Z", и год есть в начале всех.
 */
function year(value: { year?: number; date?: string }): number | null {
  if (Number.isInteger(value.year)) return value.year!;
  const fromDate = /^(\d{4})/.exec(value.date ?? "")?.[1];
  if (fromDate) {
    const n = Number(fromDate);
    // Разумный диапазон: 1000 — не год выпуска пластинки, а 3000 — опечатка.
    if (n >= 1000 && n <= 3000) return n;
  }
  return null;
}

function num(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Чистая часть: теги на вход, набор столбцов на выходе. */
export function normalizeTags(common: Partial<ICommonTagsResult> | undefined): TrackTags {
  if (!common) return { ...EMPTY_TAGS };

  return {
    title: text(common.title),
    // artists — полный список, artist — только первый. Берём список: тег
    // "Artist feat. X" в artists не разнесён, а в artist попадает целиком.
    artist: joinList(common.artists) ?? text(common.artist),
    album: text(common.album),
    genre: joinList(common.genre),
    year: year({ year: common.year, date: common.date }),
    trackNo: num(common.track?.no),
    trackTotal: num(common.track?.of),
    discNo: num(common.disk?.no),
    discTotal: num(common.disk?.of),
  };
}

/**
 * Готовая строка вставки: имена полей приводятся к именам колонок.
 *
 * Маппинг явный и обязателен. Спред `...tags` выглядит безобидно и спокойно
 * проходит проверку типов, потому что сам TrackTags корректен, — но в БД
 * колонки называются track_no, а не trackNo. Расхождение обнаруживается
 * только в момент вставки, текстом «no column named trackNo».
 */
export function toColumns(tags: TrackTags): Record<string, string | number | null> {
  return {
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    genre: tags.genre,
    year: tags.year,
    track_no: tags.trackNo,
    track_total: tags.trackTotal,
    disc_no: tags.discNo,
    disc_total: tags.discTotal,
  };
}

/**
 * Читает теги файла. Никогда не бросает: отсутствие или битость тегов — не
 * причина отказывать в загрузке, ведь сам звук мы уже проверили отдельно.
 */
export async function readTags(path: string): Promise<TrackTags> {
  try {
    const { common } = await parseFile(path);
    return normalizeTags(common);
  } catch {
    return { ...EMPTY_TAGS };
  }
}
