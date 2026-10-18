import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Knex } from "knex";
import sharp from "sharp";
import { createDb } from "../db/index.js";
import { buildApp } from "../app";
import { serviceTags } from "./service-tags";

let dir: string;
let db: Knex;
let app: ReturnType<typeof buildApp>;
let testMp3Path: string;
let testCoverPngPath: string;

async function makeAudio(path: string, durationSec: number = 1.5) {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", `sine=frequency=1000:duration=${durationSec}`,
      "-metadata", "title=Test Song",
      "-metadata", "artist=Test Band",
      "-metadata", "album=Test Album",
      "-metadata", "year=2024",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      path,
      "-y",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg failed: ${err}`);
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "musiclib-upload-test-"));
  process.env.MUSICLIB_STORAGE = dir;

  db = await createDb({ connection: { filename: join(dir, "upload-test.sqlite") } });
  await db.migrate.latest();
  app = buildApp(db);

  testMp3Path = join(dir, "source.mp3");
  await makeAudio(testMp3Path, 1.5);

  testCoverPngPath = join(dir, "cover.png");
  const pngBuffer = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  await writeFile(testCoverPngPath, pngBuffer);
});

afterAll(async () => {
  await db.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe("POST /audio/upload", () => {
  let uploadedId: string;

  test("успешная загрузка аудиофайла", async () => {
    const fileBytes = await Bun.file(testMp3Path).arrayBuffer();
    const formData = new FormData();
    formData.append("file", new File([fileBytes], "01 - Test Band - Test Song.mp3", { type: "audio/mpeg" }));

    const res = await app.handle(
      new Request("http://localhost/audio/upload", {
        method: "POST",
        body: formData,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.existed).toBe(false);
    expect(typeof body.id).toBe("string");
    expect((body.id as string).length).toBe(64); // SHA-256

    uploadedId = body.id as string;

    // Проверяем, что трек появился в БД
    const row = await db("tracks").where("id", uploadedId).first();
    expect(row).toBeDefined();
    expect(row.title).toBe("Test Song");
    expect(row.artist).toBe("Test Band");
    expect(row.album).toBe("Test Album");

    // Проверяем, что итоговый opus-файл существует на диске
    const opusFile = Bun.file(row.opus_path as string);
    expect(await opusFile.exists()).toBe(true);
  });

  test("дедупликация: повторная загрузка того же файла не перекодирует его", async () => {
    const fileBytes = await Bun.file(testMp3Path).arrayBuffer();
    const formData = new FormData();
    formData.append("file", new File([fileBytes], "01 - Test Band - Test Song.mp3", { type: "audio/mpeg" }));

    const res = await app.handle(
      new Request("http://localhost/audio/upload", {
        method: "POST",
        body: formData,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.existed).toBe(true);
    expect(body.id).toBe(uploadedId);

    // Число треков в БД не увеличилось
    const count = await db("tracks").count({ total: "*" }).first();
    expect(Number(count?.total)).toBe(1);
  });

  test("невалидный файл (текст вместо аудио) отклоняется 400", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File([new TextEncoder().encode("Not audio at all")], "fake.mp3", { type: "audio/mpeg" }),
    );

    const res = await app.handle(
      new Request("http://localhost/audio/upload", {
        method: "POST",
        body: formData,
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("файл не читается как аудио");
  });

  test("обрезанный аудиофайл отклоняется 400", async () => {
    // Берём первые 500 байт от MP3 — не сможет декодироваться или не пройдёт проверку
    const fullBytes = await Bun.file(testMp3Path).arrayBuffer();
    const truncatedBytes = fullBytes.slice(0, 500);

    const formData = new FormData();
    formData.append(
      "file",
      new File([truncatedBytes], "truncated.mp3", { type: "audio/mpeg" }),
    );

    const res = await app.handle(
      new Request("http://localhost/audio/upload", {
        method: "POST",
        body: formData,
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });
});

describe("GET /cover/:id с ресайзом (sharp)", () => {
  let coverTrackId: string;

  beforeAll(async () => {
    coverTrackId = "track-with-real-cover";
    await db("tracks").insert({
      id: coverTrackId,
      filename: "covered.mp3",
      ext: "mp3",
      size_bytes: 100,
      opus_path: `${dir}/${coverTrackId}.opus`,
      cover_path: testCoverPngPath,
      title: "Covered Track",
      meta_source: "tags",
      created_at: "2024-01-01 10:00:00",
    });
  });

  test("GET /cover/:id?w=64 отдаёт ресайз jpeg", async () => {
    const res = await app.handle(new Request(`http://localhost/cover/${coverTrackId}?w=64`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  test("HEAD /cover/:id?w=64 отдаёт только заголовки", async () => {
    const res = await app.handle(
      new Request(`http://localhost/cover/${coverTrackId}?w=64`, { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    const text = await res.text();
    expect(text).toBe("");
  });
});

describe("serviceTags в src/audio/service-tags.ts", () => {
  test("корректно извлекает MUSICLIB_ теги из native", () => {
    const meta = {
      native: {
        vorbis: [
          { id: "TITLE", value: "Song" },
          { id: "MUSICLIB_PLAYLIST", value: "Favorites" },
          { id: "MUSICLIB_RATING", value: "5" },
        ],
        id3v2: [
          { id: "TPE1", value: "Artist" },
        ],
      },
    };

    const tags = serviceTags(meta);
    expect(tags).toEqual({
      MUSICLIB_PLAYLIST: "Favorites",
      MUSICLIB_RATING: "5",
    });
  });

  test("пустой native возвращает пустой объект", () => {
    expect(serviceTags({ native: {} })).toEqual({});
  });
});
