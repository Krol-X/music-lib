/**
 * Разбор заголовка MPEG-аудио: Xing/Info, битрейт, кодировщик, VBR-метод.
 *
 * Отдельный модуль от quality.ts, потому что это чтение метаданных файла, а не
 * спектральный анализ: заголовок нужен и для подбора битрейта, и для проверки
 * целостности при загрузке.
 */


/** Заголовок всегда в первом фрейме, поэтому хватает первых килобайт файла. */
const HEADER_BYTES = 128 * 1024;

export interface MpegHeader {
  vbr: boolean;
  vbrMethod: string | null;
  encoder: string | null;
  /** Средний битрейт по счётчику байтов из Xing, кбит/с. */
  bitrateKbps: number | null;
  /** Размер аудиопотока, заявленный в Xing/Info: нужно для проверки обрезки. */
  declaredBytes: number | null;
}

function readSyncsafe(b: Uint8Array, offset: number): number {
  return (
    ((b[offset] & 0x7f) << 21) |
    ((b[offset + 1] & 0x7f) << 14) |
    ((b[offset + 2] & 0x7f) << 7) |
    (b[offset + 3] & 0x7f)
  );
}

function readU32(b: Uint8Array, offset: number): number {
  return (
    ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0
  );
}

/**
 * Метод кодирования лежит в младшей ниббле байта сразу за строкой версии
 * кодировщика: 1 — CBR, 2 — ABR, 3 — старый VBR, 4 — новый VBR. ffmpeg этот
 * байт не заполняет, поэтому у его файлов остаётся 0.
 */
const VBR_METHODS: Record<number, string> = { 1: "CBR", 2: "ABR", 3: "VBR", 4: "VBR" };

/** Частоты дискретизации MPEG-1, MPEG-2 и MPEG-2.5 по индексу из заголовка. */
const SAMPLE_RATES = [
  [44100, 48000, 32000],
  [22050, 24000, 16000],
  [11025, 12000, 8000],
];

/** Сэмплов в фрейме Layer III: у MPEG-2 и MPEG-2.5 вдвое меньше. */
const SAMPLES_PER_FRAME = [1152, 576];

/**
 * Читает Xing/Info-заголовок. "Xing" означает переменный битрейт, "Info" —
 * постоянный, это различение работает безошибочно и не требует декодирования.
 * Возвращает null для любого не-MPEG файла.
 */
export async function readMpegHeader(path: string): Promise<MpegHeader | null> {
  const buf = new Uint8Array(await Bun.file(path).slice(0, HEADER_BYTES).arrayBuffer());

  let pos = 0;
  // ID3v2 лежит перед первым фреймом, его размер закодирован syncsafe-байтами.
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    pos = 10 + readSyncsafe(buf, 6) + (buf[5] & 0x10 ? 10 : 0);
  }

  let frame = -1;
  let versionBits = 0;
  let channelMode = 0;
  let sampleRate = 0;
  for (let i = pos; i < buf.length - 4; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    versionBits = (buf[i + 1] >> 3) & 3;
    // 0 — свободный битрейт, 15 — недопустимый: это не настоящий фрейм.
    const bitrateIndex = (buf[i + 2] >> 4) & 0xf;
    const sampleRateIndex = (buf[i + 2] >> 2) & 3;
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) continue;
    channelMode = (buf[i + 3] >> 6) & 3;
    // versionBits: 3 — MPEG-1, 2 — MPEG-2, 0 — MPEG-2.5.
    sampleRate = SAMPLE_RATES[versionBits === 3 ? 0 : versionBits === 2 ? 1 : 2][sampleRateIndex];
    frame = i;
    break;
  }
  if (frame < 0) return null;

  const mono = channelMode === 3;
  const sideInfoSize = versionBits === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const magicOffset = frame + 4 + sideInfoSize;
  if (magicOffset + 4 > buf.length) return null;
  const magic = String.fromCharCode(...buf.subarray(magicOffset, magicOffset + 4));
  if (magic !== "Xing" && magic !== "Info") return null;

  // Сразу за магией идёт 32-битная маска: какие из счётчиков дальше есть.
  let offset = magicOffset + 4;
  if (offset + 4 > buf.length) return null;
  const flags = readU32(buf, offset);
  let frames = 0;
  let bytes = 0;
  if (flags & 1) {
    offset += 4;
    if (offset + 4 > buf.length) return null;
    frames = readU32(buf, offset);
  }
  if (flags & 2) {
    offset += 4;
    if (offset + 4 > buf.length) return null;
    bytes = readU32(buf, offset);
  }

  if (frame + 0x9c + 10 > buf.length) return null;
  const tag = buf.subarray(frame + 0x9c, frame + 0x9c + 9);
  const encoder = String.fromCharCode(...tag).replace(/\0.*$/, "").trim() || null;
  const methodCode = buf[frame + 0x9c + 9] & 0x0f;

  // Битрейт считается от длительности, а её знаем из счётчика фреймов:
  // frames * сэмплов на фрейм / частота дискретизации.
  const samplesPerFrame = versionBits === 3 ? SAMPLES_PER_FRAME[0] : SAMPLES_PER_FRAME[1];
  const durationSec = (frames * samplesPerFrame) / sampleRate;

  return {
    vbr: magic === "Xing",
    vbrMethod: VBR_METHODS[methodCode] ?? null,
    encoder,
    declaredBytes: bytes > 0 ? bytes : null,
    bitrateKbps:
      frames > 0 && bytes > 0 && durationSec > 0
        ? Math.round((bytes * 8) / durationSec / 1000)
        : null,
  };
}
