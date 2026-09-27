import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeQuality, measureCutoffHz, pickOpusBitrate } from "./quality";

/**
 * Фикстуры кодируются на лету из широкополосного розового шума. Важно, что
 * сигнал содержит энергию во всём диапазоне: на синусе или тишине границу
 * обрезки искать не на чем, и замер вернёт «полный диапазон» любому файлу.
 */
let dir = "";

async function ffmpeg(args: string[]) {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", ...args, "-y"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffmpeg завершился с кодом ${code}`);
}

const SOURCE_SEC = 12;

async function makeSource(name: string) {
  const path = join(dir, name);
  await ffmpeg([
    "-f", "lavfi",
    "-i", `anoisesrc=color=pink:duration=${SOURCE_SEC}:sample_rate=44100:amplitude=0.4`,
    "-f", "lavfi",
    "-i", `aevalsrc='0.3*sin(220*2*PI*t)+0.15*sin(440*2*PI*t)':d=${SOURCE_SEC}:s=44100`,
    "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0,volume=0.7",
    "-ac", "2",
    "-c:a", "pcm_s16le",
    path,
  ]);
  return path;
}

/** Кодирует готовый WAV нужным кодеком — так получаем файл с заведомым срезом. */
async function encode(source: string, name: string, codecArgs: string[]) {
  const path = join(dir, name);
  await ffmpeg(["-i", source, ...codecArgs, path]);
  return path;
}

const files: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "musiclib-quality-"));
  const source = await makeSource("source.wav");

  files.wav = source;
  files.cbr128 = await encode(source, "cbr128.mp3", ["-c:a", "libmp3lame", "-b:a", "128k"]);
  files.cbr320 = await encode(source, "cbr320.mp3", ["-c:a", "libmp3lame", "-b:a", "320k"]);
  files.vbrHigh = await encode(source, "vbr0.mp3", ["-c:a", "libmp3lame", "-q:a", "0"]);
  files.vbrLow = await encode(source, "vbr5.mp3", ["-c:a", "libmp3lame", "-q:a", "5"]);
  // 22 кГц: верх диапазона физически не может выйти за Найквест 11 кГц.
  files.lowRate = await encode(source, "lowrate.mp3", [
    "-ar", "22050", "-c:a", "libmp3lame", "-b:a", "32k",
  ]);
  await writeFile(join(dir, "garbage.mp3"), new Uint8Array(4096).map(() => Math.random() * 255));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("выбор битрейта", () => {
  test("узкая полоса получает минимум", () => {
    expect(pickOpusBitrate(15000).bitrate).toBe("128k");
    expect(pickOpusBitrate(17500).bitrate).toBe("128k");
  });

  test("средняя полоса получает 160k", () => {
    expect(pickOpusBitrate(19000).bitrate).toBe("160k");
  });

  test("полный диапазон сохраняется в 192k", () => {
    expect(pickOpusBitrate(21000).bitrate).toBe("192k");
  });

  test("нечем мерить — берётся средний битрейт, а не минимум", () => {
    expect(pickOpusBitrate(null).bitrate).toBe("160k");
  });

  test("никогда не опускается ниже 128k", () => {
    for (let hz = 0; hz <= 21000; hz += 250) {
      expect(pickOpusBitrate(hz).bitrate).not.toBe("96k");
    }
  });
});

describe("граница диапазона", () => {
  test("MP3 128k: срез в районе 16 кГц", async () => {
    const r = await analyzeQuality(files.cbr128);
    expect(r.cutoffHz).toBeGreaterThan(14000);
    expect(r.cutoffHz).toBeLessThan(19000);
    expect(r.opusBitrate).toBe("128k");
  });

  test("MP3 320k: полный диапазон", async () => {
    const r = await analyzeQuality(files.cbr320);
    expect(r.cutoffHz).toBeGreaterThan(20000);
    expect(r.opusBitrate).toBe("192k");
  });

  test("VBR -V0: полный диапазон, несмотря на средний битрейт", async () => {
    const r = await analyzeQuality(files.vbrHigh);
    // Ключевой случай: битрейт невысокий, но полоса полная.
    expect(r.vbr).toBe(true);
    expect(r.cutoffHz).toBeGreaterThan(20000);
    expect(r.opusBitrate).toBe("192k");
  });

  test("VBR -V5: срез ниже, чем у -V0", async () => {
    const low = await analyzeQuality(files.vbrLow);
    const high = await analyzeQuality(files.vbrHigh);
    expect(low.cutoffHz).not.toBeNull();
    expect(high.cutoffHz).not.toBeNull();
    expect(low.cutoffHz!).toBeLessThan(high.cutoffHz!);
    expect(low.opusBitrate).toBe("128k");
  });

  test("низкочастотный исходник не измеряется выше своего Найквиста", async () => {
    const r = await analyzeQuality(files.lowRate);
    // Найквест 11 кГц: замер обязан остановиться ниже, иначе пустота была бы
    // принята за полный диапазон.
    expect(r.cutoffHz).toBeLessThan(11500);
    expect(r.opusBitrate).toBe("128k");
  });

  test("WAV без MP3-заголовка: полоса меряется, метаданных нет", async () => {
    const r = await analyzeQuality(files.wav);
    expect(r.vbr).toBeNull();
    expect(r.vbrMethod).toBeNull();
    expect(r.encoder).toBeNull();
    expect(r.cutoffHz).toBeGreaterThan(20000);
  });
});

describe("метаданные MP3", () => {
  test("CBR распознаётся по магии Info", async () => {
    const r = await analyzeQuality(files.cbr128);
    expect(r.vbr).toBe(false);
  });

  test("VBR распознаётся по магии Xing", async () => {
    const r = await analyzeQuality(files.vbrHigh);
    expect(r.vbr).toBe(true);
  });

  test("средний битрейт близок к заданному", async () => {
    // MP3-фреймы добиваются битами padding, поэтому фактический поток может
    // чуть превышать заданный битрейт — это нормально, а не ошибка разбора.
    expect((await analyzeQuality(files.cbr128)).bitrateKbps).toBe(128);
    const full = (await analyzeQuality(files.cbr320)).bitrateKbps ?? 0;
    expect(full).toBeGreaterThan(315);
    expect(full).toBeLessThan(325);
  });

  test("длительность известна", async () => {
    const r = await analyzeQuality(files.cbr128);
    expect(r.durationSec).toBeGreaterThan(SOURCE_SEC - 1);
    expect(r.durationSec).toBeLessThan(SOURCE_SEC + 1);
  });
});

describe("устойчивость к плохим файлам", () => {
  test("мусор не роняет разбор", async () => {
    const r = await analyzeQuality(join(dir, "garbage.mp3"));
    expect(r.cutoffHz).toBeNull();
    expect(r.opusBitrate).toBe("160k");
  });

  test("несуществующий файл не роняет разбор", async () => {
    const r = await analyzeQuality(join(dir, "нет-такого.mp3"));
    expect(r.opusBitrate).toBe("160k");
  });

  test("замер без частоты дискретизации откатывается в null", async () => {
    expect(await measureCutoffHz(files.cbr128, SOURCE_SEC, 0)).toBeNull();
  });

  test("замер без длительности откатывается в null", async () => {
    expect(await measureCutoffHz(files.cbr128, 0, 44100)).toBeNull();
  });
});
