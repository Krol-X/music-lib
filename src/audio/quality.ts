import { parseFile } from "music-metadata";
import { readMpegHeader, type MpegHeader } from "./mpeg-header";

/**
 * Определяет, что можно сохранить при переводе в Opus, и выбирает под это
 * битрейт.
 *
 * Метаданные MP3 (Xing/Info) дают VBR или CBR и средний битрейт, но не дают
 * главного: на какой частоте исходник уже пустой. Считать битрейт одинаковым для
 * всей библиотеки — значит либо переплачивать место на файлах, срезанных под
 * 16 кГц, либо тихо срезать верх на файлах с полным диапазоном. Поэтому границу
 * измеряем по самому звуку: lossy-кодек ставит в спектре стену, и её видно.
 */

/** Всё, что удалось выяснить про исходник, плюс решение по битрейту. */
export interface QualityReport {
  /** Средний битрейт исходника, кбит/с. null, если определить не удалось. */
  bitrateKbps: number | null;
  /** MP3 собран переменным битрейсом. null, если это не MP3. */
  vbr: boolean | null;
  /** Метод кодирования из LAME-тега: CBR, ABR, VBR. */
  vbrMethod: string | null;
  /** Строка кодировщика из LAME-тега, например "LAME3.100" или "Lavc60". */
  encoder: string | null;
  durationSec: number | null;
  /**
   * Частота, выше которой в исходнике уже нет содержания. null, если
   * измерить не вышло.
   */
  cutoffHz: number | null;
  /** Битрейт Opus, подобранный под cutoffHz. */
  opusBitrate: string;
  /** Почему выбран этот битрейт — показываем пользователю при загрузке. */
  reason: string;
}

/** Ниже этого не опускаемся: на слух 128k Opus неотличим, экономия не нужна. */
const MIN_BITRATE = "128k";

/**
 * Насколько резкое падение уровня между соседними точками считать обрывом
 * полосы. Замер показал: у файлов с полным диапазоном колебания между
 * соседними частотами не превышают ~7 дБ, а настоящая обрезка даёт 20–36 дБ.
 * Порог 12 дБ сидит посередине с большим запасом в обе стороны.
 */
const CLIFF_DB = 12;

/**
 * Верхняя точка сетки измерения. 21 кГц, а не 20: полноценный CD-диапазон
 * доходит до 20,5 кГц, и при потолке ровно в 20 кГц такой файл измерился бы
 * как граничный, хотя на самом деле полный.
 */
const TOP_HZ = 21000;

/** Начало сетки: заведомо внутри полосы любого lossy-кодек. */
const GRID_START_HZ = 12000;

/** Ширина окна, которое декодируем. Длиннее — медленнее, короче — шумнее. */
const WINDOW_SEC = 2.5;

/** Декодируем в mono 48 кГц: частота дискретизации известна, спектр не подменён. */
const PROBE_RATE = 48000;

/**
 * Точки, где берём окна. Не одна середина трека: там может быть длинный
 * переход или тихий кусок, и тогда верхний диапазон покажется пустым у файла,
 * который на самом деле полноценный.
 */
const WINDOW_POSITIONS = [0.15, 0.5, 0.85];

/**
 * Полоса, которую усредняем вокруг каждой точки сетки.
 *
 * Замер в одной частоте слишком шумный: у полноценного файла разброс между
 * соседними частотами достигал 14 дБ, то есть был сопоставим с самой обрезкой.
 * Усреднение по полосе ±400 Гц убирает эту болтанку, оставляя настоящий обвал
 * нетронутым.
 */
const BAND_HALF_WIDTH_HZ = 400;
const BAND_STEP_HZ = 100;

/**
 * Сетка частот для замера под конкретный исходник.
 *
 * Выше половины частоты дискретизации мерить бессмысленно: там у исходника
 * физически нет ничего, и мы бы приняли пустоту за «полный диапазон». Поэтому
 * потолок сетки ограничен Найквестом. Если исходник совсем низкочастотный, для
 * него строится своя сетка в нижней части его диапазона.
 */
function buildProbeGrid(sampleRate: number): number[] | null {
  const nyquist = sampleRate / 2;
  const top = Math.min(TOP_HZ, nyquist - 100);

  const start = top > GRID_START_HZ + 2000 ? GRID_START_HZ : Math.round(nyquist * 0.5);
  const points: number[] = [];
  for (let hz = start; hz <= top; hz += 1000) points.push(hz);

  return points.length < 2 ? null : points;
}

// ── измерение границы диапазона ────────────────────────────────────────────

/**
 * Мощность ровно одной частоты по алгоритму Гёрцеля. Полный FFT тут не нужен:
 * нас интересует не весь спектр, а два десятка точек, а Гёрцель даёт одну
 * частоту за один проход и без внешних зависимостей.
 */
function powerAt(pcm: Int16Array, sampleRate: number, freq: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s0 = pcm[i] / 32768 + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.max(s1 * s1 + s2 * s2 - coeff * s1 * s2, 0);
}

/**
 * Уровень в децибелах, усреднённый по полосе вокруг частоты. Усредняем именно
 * мощности, а не децибелы: так вклад соседних частот складывается физически
 * правильно.
 */
function bandLevelDb(pcm: Int16Array, freq: number): number {
  let sum = 0;
  for (let d = -BAND_HALF_WIDTH_HZ; d <= BAND_HALF_WIDTH_HZ; d += BAND_STEP_HZ) {
    sum += powerAt(pcm, PROBE_RATE, freq + d);
  }
  return 10 * Math.log10(sum + 1e-24);
}

/**
 * Декодирует несколько коротких окон трека одним вызовом ffmpeg.
 * Быстрый seek через -ss до -i не заставляет ffmpeg переваривать файл с начала.
 */
async function decodeWindows(path: string, durationSec: number): Promise<Int16Array | null> {
  const windows = durationSec > WINDOW_SEC * 1.5 ? WINDOW_POSITIONS : [0];
  const args: string[] = [];
  for (const position of windows) {
    const start = Math.max(0, Math.min(durationSec - WINDOW_SEC, durationSec * position));
    args.push("-ss", start.toFixed(3), "-t", String(WINDOW_SEC), "-i", path);
  }
  const filter = `${windows.map((_, i) => `[${i}:a]`).join("")}concat=n=${windows.length}:v=0:a=1`;

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel", "error",
      ...args,
      "-filter_complex", filter,
      "-ac", "1",
      "-ar", String(PROBE_RATE),
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  // Код 0 и непустой вывод — единственный признак, что декодирование удалось:
  // в stderr ffmpeg может писать ворнинги даже при успешном разматывании.
  const code = await proc.exited;
  if (code !== 0) return null;

  const buf = await new Response(proc.stdout).arrayBuffer();
  if (buf.byteLength < 2) return null;
  const safeLength = buf.byteLength - (buf.byteLength % 2);
  const pcm = new Int16Array(buf, 0, safeLength / 2);
  return pcm.length > 0 ? pcm : null;
}

/**
 * Ищет частоту, выше которой сигнала нет.
 *
 * Ищем не по абсолютному уровню, а по обрыву: lossy-кодек ставит стену, и на
 * графике это резкое падение между двумя соседними точками сетки. Сравнение с
 * опорной частотой не годится — у тихой записи вся полоса смещена вниз, и
 * сравнение искажает результат.
 */
function findCutoff(pcm: Int16Array, grid: number[]): number {
  const levels = grid.map((freq) => bandLevelDb(pcm, freq));

  let steepest = 0;
  let bracket = 0;
  for (let i = 1; i < levels.length; i++) {
    const drop = levels[i - 1] - levels[i];
    if (drop > steepest) {
      steepest = drop;
      bracket = i;
    }
  }
  // Обрыва нет: файл держит весь диапазон до верхней точки сетки.
  if (steepest < CLIFF_DB) return grid[grid.length - 1];

  // Уточняем границу между точками сетки, где обрыв обнаружился.
  let low = grid[bracket - 1];
  let high = grid[bracket];
  while (high - low > 200) {
    const mid = (low + high) / 2;
    if (bandLevelDb(pcm, mid) > levels[bracket - 1] - CLIFF_DB) low = mid;
    else high = mid;
  }
  return Math.round(low);
}

/**
 * Верхняя граница диапазона исходника в герцах. null, если ffmpeg не смог
 * декодировать файл или мерить нечего: это не повод отказывать в загрузке,
 * измерение просто откатывается на безопасное значение.
 */
export async function measureCutoffHz(
  path: string,
  durationSec: number,
  sampleRate: number,
): Promise<number | null> {
  if (!(durationSec > 0) || !(sampleRate > 0)) return null;
  const grid = buildProbeGrid(sampleRate);
  if (!grid) return null;
  const pcm = await decodeWindows(path, durationSec);
  return pcm ? findCutoff(pcm, grid) : null;
}

// ── политика битрейта ──────────────────────────────────────────────────────

/**
 * Границы выбора битрейта.
 *
 * Замер показал, что сам Opus 128k держит диапазон примерно до 19,5 кГц.
 * Значит для источника ниже этой отметки 128k не ограничивает полосу: всё, что
 * в исходнике есть, в него поместится. Покупать 160k/192k в этом случае можно
 * только ради транзиентов и шума, а не ради верхних частот.
 *
 * Дальше логика такая:
 *  — до 18 кГц: полоса уже узкая, 128k передаёт её целиком, выше — трата места;
 *  — 18–20 кГц: полосу 128k умеет, но на краях ей не хватает бит на чистоту,
 *    поэтому берём 160k как среднее;
 *  — выше 20 кГц: 128k упирается в собственный предел, и верх диапазона
 *    приходится кодировать с меньшим запасом по битам, поэтому 192k.
 *
 * Пороги смещены вверх с расчётом на погрешность самого замера: усреднение по
 * полосе ±400 Гц размывает границу обрезки, и измеренное значение оказывается
 * примерно на килогерц выше настоящего (MP3 128k с реальным срезом на 15,9 кГц
 * меряется как ~17,1 кГц). Без этой поправки файлы на 128k попадали бы в 160k
 * впритык и результаты дрожали бы от загрузки к загрузке.
 *
 * Границы — инженерный выбор, а не измеренная константа: подвинуть их на
 * килогерц в другую сторону почти ничего не меняет.
 */
const FULL_BAND_HZ = 20000;
const NARROW_BAND_HZ = 18000;

/**
 * Битрейт под границу диапазона. Отдавать 192k файлу, у которого звук обрезан
 * на 16 кГц, смысла нет — там нечего передавать. И наоборот, 128k для полного
 * диапазона — это тихая потеря верха.
 */
export function pickOpusBitrate(cutoffHz: number | null): { bitrate: string; reason: string } {
  const khz = cutoffHz === null ? null : Math.round(cutoffHz / 100) / 10;
  if (cutoffHz === null) {
    return {
      bitrate: "160k",
      reason: "не удалось измерить диапазон, берём средний битрейт",
    };
  }
  if (cutoffHz <= NARROW_BAND_HZ) {
    return { bitrate: MIN_BITRATE, reason: `диапазон обрезан на ~${khz} кГц, 128k хватает` };
  }
  if (cutoffHz <= FULL_BAND_HZ) {
    return { bitrate: "160k", reason: `диапазон до ~${khz} кГц, хватает 160k` };
  }
  return { bitrate: "192k", reason: `диапазон до ~${khz} кГц, сохраняем 192k` };
}

/**
 * Полный разбор исходника. Любая ошибка на любом шаге не должна ронять
 * загрузку: качество — полезная, но необязательная информация.
 */
export async function analyzeQuality(path: string): Promise<QualityReport> {
  let durationSec: number | null = null;
  let sampleRate = 0;
  try {
    const meta = await parseFile(path);
    const { duration, sampleRate: rate } = meta.format;
    if (typeof duration === "number" && Number.isFinite(duration)) durationSec = duration;
    if (typeof rate === "number" && Number.isFinite(rate)) sampleRate = rate;
  } catch {
    // Нечитаемый файл дойдёт до ffmpeg и там выдаст внятную ошибку.
  }

  let header: MpegHeader | null = null;
  try {
    header = await readMpegHeader(path);
  } catch {
    // Не MP3 — дальше работает только спектральный анализ.
  }

  let cutoffHz: number | null = null;
  try {
    cutoffHz = await measureCutoffHz(path, durationSec ?? 0, sampleRate);
  } catch {
    // Останется null, pickOpusBitrate отдаст 160k.
  }

  const { bitrate, reason } = pickOpusBitrate(cutoffHz);
  return {
    bitrateKbps: header?.bitrateKbps ?? null,
    vbr: header?.vbr ?? null,
    vbrMethod: header?.vbrMethod ?? null,
    encoder: header?.encoder ?? null,
    durationSec,
    cutoffHz,
    opusBitrate: bitrate,
    reason,
  };
}
