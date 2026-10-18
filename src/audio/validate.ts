import { readMpegHeader } from "./mpeg-header";

/**
 * Проверка входа перед тем, как он попадёт в библиотеку.
 *
 * Пайплайн конвертации сам по себе пропускает битые файлы: ffmpeg на обрезанном
 * MP3 завершается с кодом 0 и пишет корректный, но неполный Opus. Без проверок
 * в базу уходит трек на одну секунду вместо двадцати, а ответ клиенту —
 * `success: true`.
 */

export class InvalidAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAudioError";
  }
}

/**
 * Ниже этой доли от заявленной длительности результат считается битым.
 *
 * Порог выбран по замеру: на 19 валидных фикстурах выход был длиннее входа от
 * +0,03% до +0,54% (это preskip кодировщика Opus), а обрезанный файл давал
 * −95%. Порог 0,95 разделяет эти группы с большим запасом с обеих сторон.
 */
export const MIN_DURATION_RATIO = 0.95;

/**
 * Доля от заявленного Xing/Info размера потока, ниже которой файл считается
 * обрезанным.
 *
 * На валидных файлах реальный размер был 100,00%–100,22% от заявленного:
 * заявленный счётчик покрывает только аудиопоток, а сверху доезжает ID3-тег.
 * То есть меньше 100% он не бывает, и 0,99 берёт запас на кодировщики, которые
 * округляют счётчик вниз.
 */
export const MIN_SIZE_RATIO = 0.99;

/**
 * Длительность аудиопотока по ffprobe. null — файл не декодируется как аудио
 * (пустой, текст с расширением .mp3, оборванный в середине заголовка).
 */
export async function probeDurationSec(path: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(
      [
        "ffprobe",
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    const value = Number.parseFloat(out);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Результат проверки входа. Все поля — что увидели инструменты. */
export interface InputCheck {
  durationSec: number | null;
  declaredBytes: number | null;
  actualBytes: number;
}

/**
 * Читает вход и собирает всё, о чём стоит знать до конвертации. Сама по себе
 * проверок не делает: вызывающая сторона решает, что с этим делать.
 */
export async function inspectInput(path: string): Promise<InputCheck> {
  const [durationSec, header, actualBytes] = await Promise.all([
    probeDurationSec(path),
    readMpegHeader(path),
    Bun.file(path).size,
  ]);

  return { durationSec, declaredBytes: header?.declaredBytes ?? null, actualBytes };
}

/** Ровно та логика сравнения, ради которой есть тесты. */
export function truncationVerdict(input: InputCheck): "truncated-by-size" | "ok" | "no-xing" {
  if (input.declaredBytes === null) return "no-xing";
  return input.actualBytes >= input.declaredBytes * MIN_SIZE_RATIO ? "ok" : "truncated-by-size";
}

export function durationVerdict(inputSec: number, outputSec: number): "shorter" | "ok" {
  return outputSec >= inputSec * MIN_DURATION_RATIO ? "ok" : "shorter";
}

export interface ConversionCheck {
  inputDurationSec: number;
  outputDurationSec: number;
  truncatedBySize: boolean;
  declaredBytes: number | null;
  actualBytes: number;
}

/**
 * Сверяет заявленную длительность входа с реально декодируемой.
 *
 * Это ловит главный случай обрезки: ffprobe длительность обрезанного MP3 берёт
 * из счётчика фреймов в Xing-заголовке и уверенно сообщает все 20 секунд,
 * хотя декодируется там меньше секунды. На выходе же лежит то, что ffmpeg
 * действительно смог декодировать. Расхождение и есть признак обрезки.
 */
export async function checkConversion(
  inputPath: string,
  outputPath: string,
  input: InputCheck,
): Promise<ConversionCheck> {
  const outputDurationSec = await probeDurationSec(outputPath);

  if (input.durationSec === null) {
    throw new InvalidAudioError("исходник не декодируется как аудио");
  }
  if (outputDurationSec === null) {
    throw new InvalidAudioError("не удалось прочитать длительность результата");
  }
  if (durationVerdict(input.durationSec, outputDurationSec) === "shorter") {
    throw new InvalidAudioError(
      `файл похоже обрезан: заявлено ${input.durationSec.toFixed(1)} с, ` +
        `декодируется ${outputDurationSec.toFixed(1)} с`,
    );
  }

  return {
    inputDurationSec: input.durationSec,
    outputDurationSec,
    truncatedBySize: truncationVerdict(input) === "truncated-by-size",
    declaredBytes: input.declaredBytes,
    actualBytes: input.actualBytes,
  };
}
