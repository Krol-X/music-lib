import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidAudioError,
  checkConversion,
  durationVerdict,
  inspectInput,
  probeDurationSec,
  truncationVerdict,
} from "./validate";

let dir = "";

async function ffmpeg(args: string[]) {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", ...args, "-y"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffmpeg завершился с кодом ${code}`);
}

const SEC = 10;

const files: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "musiclib-validate-"));

  const source = join(dir, "source.wav");
  await ffmpeg([
    "-f", "lavfi",
    "-i", `anoisesrc=color=pink:duration=${SEC}:sample_rate=44100:amplitude=0.4`,
    "-c:a", "pcm_s16le",
    source,
  ]);

  // CBR через LAME: у него есть Xing/Info со счётчиком байтов.
  files.cbr = join(dir, "cbr.mp3");
  await ffmpeg(["-i", source, "-c:a", "libmp3lame", "-b:a", "192k", files.cbr]);

  // Обрезанный MP3: заголовок Xing/Info остаётся и продолжает обещать все
  // 10 секунд, хотя данных в файле меньше двух.
  files.truncated = join(dir, "truncated.mp3");
  const full = await readFile(files.cbr);
  await writeFile(files.truncated, full.subarray(0, Math.floor(full.length * 0.15)));

  // Файл без Xing/Info: ffmpeg так не пишет, поэтому проверка размера тут
  // обязана молча выключиться и доверить работу проверке длительности.
  files.noXing = join(dir, "noxing.mp3");
  await ffmpeg(["-i", source, "-c:a", "libmp3lame", "-b:a", "192k", "-write_xing", "0", files.noXing]);

  // Совсем не аудио.
  files.text = join(dir, "notaudio.mp3");
  await writeFile(files.text, "это текст, а не аудио\n");

  // Корректный Opus, чтобы сверить «вход хороший, выход хороший».
  files.goodOpus = join(dir, "good.opus");
  await ffmpeg(["-i", source, "-c:a", "libopus", "-b:a", "128k", files.goodOpus]);
});

afterAll(async () => {
  await Bun.$`rm -rf ${dir}`.quiet();
});

describe("сверка длительности", () => {
  test("выход той же длины проходит", () => {
    expect(durationVerdict(20, 20.006)).toBe("ok");
  });

  test("выход длиннее входа проходит: это preskip кодировщика", () => {
    expect(durationVerdict(1.2, 1.206)).toBe("ok");
  });

  test("потеря 4% ещё проходит", () => {
    expect(durationVerdict(100, 96)).toBe("ok");
  });

  test("потеря 6% уже ловится", () => {
    expect(durationVerdict(100, 94)).toBe("shorter");
  });

  test("обрезанный до трети — ловится", () => {
    expect(durationVerdict(20, 0.97)).toBe("shorter");
  });
});

describe("сверка размера по Xing/Info", () => {
  test("размер совпадает с заявленным", () => {
    expect(truncationVerdict({ declaredBytes: 1000, actualBytes: 1000, durationSec: 10 })).toBe("ok");
  });

  test("ID3-тег сверху не считается обрезкой", () => {
    expect(truncationVerdict({ declaredBytes: 1000, actualBytes: 1022, durationSec: 10 })).toBe("ok");
  });

  test("файл заметно короче заявленного — обрезка", () => {
    expect(truncationVerdict({ declaredBytes: 1000, actualBytes: 150, durationSec: 10 })).toBe(
      "truncated-by-size",
    );
  });

  test("без Xing/Info проверка выключается, а не ругается", () => {
    expect(truncationVerdict({ declaredBytes: null, actualBytes: 10, durationSec: 10 })).toBe("no-xing");
  });
});

describe("чтение входа", () => {
  test("ffprobe находит длительность нормального MP3", async () => {
    const d = await probeDurationSec(files.cbr);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(SEC - 1);
  });

  test("текст вместо аудио не декодируется", async () => {
    expect(await probeDurationSec(files.text)).toBeNull();
  });

  test("несуществующий файл не декодируется", async () => {
    expect(await probeDurationSec(join(dir, "нет-такого.mp3"))).toBeNull();
  });

  test("у CBR-файла читается заявленный размер потока", async () => {
    const info = await inspectInput(files.cbr);
    expect(info.declaredBytes).not.toBeNull();
    expect(info.declaredBytes!).toBeGreaterThan(0);
    expect(truncationVerdict(info)).toBe("ok");
  });

  test("обрезанный файл виден по размеру, хотя ffprobe считает его полным", async () => {
    const info = await inspectInput(files.truncated);
    // Вот это самое неприятное: длительность врёт, а размер честно падает.
    expect(info.durationSec!).toBeGreaterThan(SEC - 1);
    expect(truncationVerdict(info)).toBe("truncated-by-size");
  });

  test("файл без Xing/Info проходит, а не падает на null", async () => {
    const info = await inspectInput(files.noXing);
    // Фикстура должна действительно быть без заголовка, иначе тест ничего
    // не проверяет.
    expect(info.declaredBytes).toBeNull();
    expect(truncationVerdict(info)).toBe("no-xing");
    expect(info.durationSec!).toBeGreaterThan(SEC - 1);
  });
});

describe("проверка результата конвертации", () => {
  test("нормальный вход и нормальный выход проходят", async () => {
    const info = await inspectInput(files.cbr);
    const result = await checkConversion(files.cbr, files.goodOpus, info);
    expect(result.truncatedBySize).toBe(false);
    expect(result.outputDurationSec).toBeGreaterThan(0);
  });

  test("обрезанный вход ловится по длительности, даже если Xing врёт", async () => {
    const info = await inspectInput(files.truncated);
    await ffmpeg(["-i", files.truncated, "-c:a", "libopus", "-b:a", "128k",
      join(dir, "from-truncated.opus")]);
    expect(checkConversion(files.truncated, join(dir, "from-truncated.opus"), info)).rejects
      .toThrow(InvalidAudioError);
  });

  test("вход, который не декодируется, отвергается сразу", async () => {
    const info = await inspectInput(files.text);
    expect(info.durationSec).toBeNull();
    expect(checkConversion(files.text, files.goodOpus, info)).rejects.toThrow(
      /не декодируется как аудио/,
    );
  });

  test("нечитаемый результат отвергается", async () => {
    const info = await inspectInput(files.cbr);
    const empty = join(dir, "empty.opus");
    await writeFile(empty, "");
    expect(checkConversion(files.cbr, empty, info)).rejects.toThrow(
      /не удалось прочитать длительность/,
    );
  });
});
