import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverMime, extractCover } from "./cover";

let dir: string;

async function ffmpeg(args: string[]) {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", ...args, "-y"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffmpeg завершился с кодом ${code}`);
}

let withCover = "";
let withoutCover = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "musiclib-cover-"));

  const wav = join(dir, "source.wav");
  await ffmpeg([
    "-f", "lavfi",
    "-i", "anoisesrc=color=pink:duration=1:sample_rate=44100",
    "-c:a", "pcm_s16le",
    wav,
  ]);

  // APIC-картинка в ID3v2: mjpeg и есть то, что пишут тегировщики.
  const jpg = join(dir, "cover.jpg");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=8x8", "-frames:v", "1", "-c:v", "mjpeg", jpg]);

  withCover = join(dir, "with-cover.mp3");
  await ffmpeg([
    "-i", wav,
    "-i", jpg,
    "-map", "0:a",
    "-map", "1:v",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-c:v", "copy",
    "-id3v2_version", "3",
    withCover,
  ]);

  withoutCover = join(dir, "no-cover.mp3");
  await ffmpeg(["-i", wav, "-c:a", "libmp3lame", "-b:a", "128k", withoutCover]);
});

afterAll(async () => {
  await Bun.$`rm -rf ${dir}`.quiet();
});

describe("извлечение обложки", () => {
  test("у файла с обложкой она находится", async () => {
    const cover = await extractCover(withCover);
    expect(cover).not.toBeNull();
    expect(cover!.mime).toBe("image/jpeg");
    expect(cover!.ext).toBe("jpg");
    expect(cover!.data.byteLength).toBeGreaterThan(0);
  });

  test("без обложки вернётся null, а не исключение", async () => {
    expect(await extractCover(withoutCover)).toBeNull();
  });

  test("несуществующий файл — null, а не исключение", async () => {
    expect(await extractCover(join(dir, "нет-такого.mp3"))).toBeNull();
  });
});

describe("mime по расширению", () => {
  test("jpg и png распознаются", () => {
    expect(coverMime("jpg")).toBe("image/jpeg");
    expect(coverMime("png")).toBe("image/png");
  });

  test("неизвестное расширение — честный octet-stream", () => {
    expect(coverMime("gif")).toBe("application/octet-stream");
    expect(coverMime("")).toBe("application/octet-stream");
  });
});
