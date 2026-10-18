import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Knex } from "knex";
import { createDb } from "./db/index.js";
import { buildApp } from "./app";

let dir: string;
let db: Knex;
let app: ReturnType<typeof buildApp>;

interface Fixture {
  id: string;
  filename: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  trackNo: number | null;
  trackTotal: number | null;
  discNo: number | null;
  discTotal: number | null;
  metaSource: string;
  createdAt: string;
  coverPath?: string;
}

const FIXTURES: Fixture[] = [
  {
    id: "track-1",
    filename: "01 - Alpha - Sunrise.mp3",
    title: "Sunrise",
    artist: "Alpha",
    album: "Morning",
    genre: "Rock",
    year: 2001,
    trackNo: 1,
    trackTotal: 3,
    discNo: 1,
    discTotal: 1,
    metaSource: "tags",
    createdAt: "2024-01-03 10:00:00",
  },
  {
    id: "track-2",
    filename: "02 - Alpha - Noon.mp3",
    title: "Noon",
    artist: "Alpha",
    album: "Morning",
    genre: "Rock",
    year: 2001,
    trackNo: 2,
    trackTotal: 3,
    discNo: 1,
    discTotal: 1,
    metaSource: "tags",
    createdAt: "2024-01-02 10:00:00",
  },
  {
    id: "track-3",
    filename: "Beta - Nightfall.mp3",
    title: "Nightfall",
    artist: "Beta",
    album: "Evening",
    genre: "Jazz",
    year: 1995,
    trackNo: null,
    trackTotal: null,
    discNo: null,
    discTotal: null,
    metaSource: "tags",
    createdAt: "2024-01-01 10:00:00",
  },
  {
    id: "track-4",
    filename: "03 Rip Without Tags.mp3",
    // Рип без тегов: единственный трек с meta_source = filename, тот самый,
    // который правится PATCH-ом.
    title: "Rip Without Tags",
    artist: "Alpha",
    album: null,
    genre: null,
    year: null,
    trackNo: 3,
    trackTotal: null,
    discNo: null,
    discTotal: null,
    metaSource: "filename",
    createdAt: "2024-01-04 10:00:00",
  },
  {
    id: "track-5",
    filename: "veryslow.wav",
    title: null,
    artist: null,
    album: null,
    genre: null,
    year: null,
    trackNo: null,
    trackTotal: null,
    discNo: null,
    discTotal: null,
    metaSource: "none",
    createdAt: "2024-01-05 10:00:00",
  },
];

/** % и _ это ровно сепараторы LIKE, поэтому литеральные не совпадают по не-экранированной строке. */

async function seed() {
  for (const f of FIXTURES) {
    await db("tracks").insert({
      id: f.id,
      filename: f.filename,
      ext: "mp3",
      size_bytes: 100,
      // Схема требует не-nullable путь; файл на диске не существует, и это
      // норм: GET /audio/:id обязана ответить 404 на отсутствующий файл.
      opus_path: `${dir}/${f.id}. nonexistent.opus`,
      opus_bitrate: "160k",
      bitrate_kbps: null,
      vbr: null,
      vbr_method: null,
      encoder: null,
      duration_sec: null,
      cutoff_hz: null,
      cover_path: f.coverPath ?? null,
      title: f.title,
      artist: f.artist,
      album: f.album,
      genre: f.genre,
      year: f.year,
      track_no: f.trackNo,
      track_total: f.trackTotal,
      disc_no: f.discNo,
      disc_total: f.discTotal,
      meta_source: f.metaSource,
      created_at: f.createdAt,
    });
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "musiclib-app-"));
  // app.ts читает env на вызов: тест на DELETE проверяет и реальные пути
  // в "хранилище", поэтому скормим ему tmp-каталог.
  process.env.MUSICLIB_STORAGE = dir;
  db = await createDb({ connection: { filename: join(dir, "test.sqlite") } });
  await db.migrate.latest();
  await seed();
  app = buildApp(db);
});

afterAll(async () => {
  await db.destroy();
  await rm(dir, { recursive: true, force: true });
});

function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return (async () => {
    const res = await app.handle(new Request(`http://localhost${path}`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  })();
}

async function patchJson(
  id: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.handle(
    new Request(`http://localhost/tracks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function deleteJson(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.handle(new Request(`http://localhost/tracks/${id}`, { method: "DELETE" }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function ids(body: Record<string, unknown>): unknown[] {
  return (body.items as Record<string, unknown>[]).map((t) => t.id);
}

describe("GET /tracks", () => {
  test("по умолчанию: все треки, newest first", async () => {
    const { status, body } = await getJson("/tracks");
    expect(status).toBe(200);
    expect(body.total).toBe(FIXTURES.length);
    expect(ids(body)).toEqual([
      "track-5",
      "track-4",
      "track-1",
      "track-2",
      "track-3",
    ]);
  });

  test("пагинация limit и offset", async () => {
    const { body } = await getJson("/tracks?limit=2&offset=1");
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(ids(body)).toEqual(["track-4", "track-1"]);
  });

  test("limit выше потолка ограничен", async () => {
    const { body } = await getJson("/tracks?limit=10000");
    expect(body.limit).toBe(200);
  });

  test("мусорные limit и offset не роняют", async () => {
    const { body } = await getJson("/tracks?limit=abc&offset=-5");
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  test("поиск q регистронезависим и находит по artist", async () => {
    const { body } = await getJson("/tracks?q=beta");
    expect(ids(body)).toEqual(["track-3"]);
  });

  test("% и _ в q считаются литералами, а не масками", async () => {
    // '%' эквивалентен LIKE '%%', что совпадает со всем подряд, поэтому без
    // экранирования тест бы прошёл впустую. "_" соответствует любому символу,
    // поэтому "N_on" находит "Noon"; литеральное подчёркивание — нет.
    const { body: percentBody } = await getJson(`/tracks?q=${encodeURIComponent("%")}`);
    const { body: underscoreBody } = await getJson("/tracks?q=N_on");
    expect(ids(percentBody)).toEqual([]);
    expect(ids(underscoreBody)).toEqual([]); // литеральное "_" не совпадает с "o"
    const { body } = await getJson("/tracks?q=Noon");
    expect(ids(body)).toEqual(["track-2"]);
  });

  test("фильтр artist точный, регистронезависимый", async () => {
    const { body } = await getJson("/tracks?artist=alpha");
    expect(ids(body)).toEqual(["track-4", "track-1", "track-2"]);
  });

  test("фильтр genre работает", async () => {
    const { body } = await getJson("/tracks?genre=jazz");
    expect(ids(body)).toEqual(["track-3"]);
  });

  test("фильтры вместе сузают до пересечения", async () => {
    const { body } = await getJson("/tracks?artist=alpha&genre=jazz");
    expect(body.total).toBe(0);
    expect(ids(body)).toEqual([]);
  });

  test("сортировка по album — составной порядок внутри альбома", async () => {
    const { body } = await getJson("/tracks?sort=album&order=asc");
    expect(ids(body)).toEqual([
      "track-1",
      "track-2",
      "track-4",
      "track-3",
      "track-5",
    ]);
  });

  test("сортировка по title ставит null в конец", async () => {
    const { body } = await getJson("/tracks?sort=title&order=asc");
    const orderedIds = ids(body);
    expect(orderedIds[orderedIds.length - 1]).toBe("track-5");
  });

  test("неизвестная сортировка откатывается на created", async () => {
    const { body } = await getJson("/tracks?sort=trash");
    expect(ids(body)).toEqual([
      "track-5",
      "track-4",
      "track-1",
      "track-2",
      "track-3",
    ]);
  });

  test("список не содержит внутренних путей", async () => {
    const { body } = await getJson("/tracks");
    expect(JSON.stringify(body)).not.toContain("opus_path");
    expect(JSON.stringify(body)).not.toContain("cover_path");
  });

  test("у трека без обложки coverUrl null, у стрима аудио есть", async () => {
    const { body } = await getJson("/tracks/track-1");
    expect(body.audioUrl).toBe("/audio/track-1");
    expect(body.coverUrl).toBeNull();
  });
});

describe("GET /tracks/:id", () => {
  test("одиночный трек отдаёт поля", async () => {
    const { status, body } = await getJson("/tracks/track-3");
    expect(status).toBe(200);
    expect(body.title).toBe("Nightfall");
    expect(body.artist).toBe("Beta");
    expect(body.metaSource).toBe("tags");
    // sqlite-время читает Date любого клиента: ISO с Z, а не пробел.
    expect(String(body.createdAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(body.vbr).toBeNull();
  });

  test("неизвестный id — 404 в едином формате", async () => {
    const { status, body } = await getJson("/tracks/сидит-другой-ключ");
    expect(status).toBe(404);
    expect(body.error).toBe("трек не найден");
  });
});

describe("PATCH /tracks/:id", () => {
  test("правка названий трека из догадки: meta_source становится edited", async () => {
    const { status, body } = await patchJson("track-4", {
      artist: "Alpha",
      album: "Morning",
      genre: "Rock",
    });
    expect(status).toBe(200);
    expect(body.metaSource).toBe("edited");
    expect(body.artist).toBe("Alpha");

    const row = await db("tracks").where("id", "track-4").first();
    expect(row.album).toBe("Morning");
  });

  test("пустая строка вычищает поле, а не записывает пробелы", async () => {
    const { body } = await patchJson("track-4", { genre: "  " });
    expect(body.genre).toBeNull();

    await patchJson("track-4", { genre: "Rock" });
  });

  test("null не разрешён: очистка только пустой строкой", async () => {
    const res = await app.handle(
      new Request("http://localhost/tracks/track-4", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: null }),
      }),
    );
    expect(res.status).toBe(422);
  });

  test("год вне диапазона отклоняется", async () => {
    const { status } = await patchJson("track-4", { year: 42 });
    expect(status).toBe(400);
  });

  test("пустой PATCH ничего не обновляет и не трогает meta_source", async () => {
    const { body } = await patchJson("track-1", {});
    expect(body.metaSource).toBe("tags");
  });

  test("правка с unknown id — 404", async () => {
    const { status } = await patchJson("нет-такого", { title: "x" });
    expect(status).toBe(404);
  });

  test("год вне строк — мусор отклоняется схемой", async () => {
    const res = await app.handle(
      new Request("http://localhost/tracks/track-4", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: "девятьсот" }),
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe("GET /cover/:id", () => {
  let coverFile: string;

  beforeAll(async () => {
    coverFile = join(dir, "cover-test.png");
    await writeFile(coverFile, "поддельные байты, суть не в них");
    await db("tracks")
      .where("id", "track-1")
      .update({ cover_path: coverFile });
  });

  afterAll(async () => {
    await db("tracks").where("id", "track-1").update({ cover_path: null });
  });

  test("обложка отдаётся с mime по расширению", async () => {
    const res = await app.handle(new Request("http://localhost/cover/track-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(await res.text()).toContain("поддельные");
  });

  test("HEAD отдаёт только заголовки", async () => {
    const res = await app.handle(new Request("http://localhost/cover/track-1", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(await res.text()).toBe("");
  });

  test("у трека без обложки — 404", async () => {
    const { status, body } = await getJson("/cover/track-2");
    expect(status).toBe(404);
    expect(body.error).toBe("у трека нет обложки");
  });
});

describe("GET /audio/:id", () => {
  let audioFile: string;

  beforeAll(async () => {
    audioFile = join(dir, "audio-test.opus");
    await writeFile(audioFile, "0123456789".repeat(10));
    await db("tracks")
      .where("id", "track-2")
      .update({ opus_path: audioFile });
  });

  afterAll(async () => {
    await db("tracks")
      .where("id", "track-2")
      .update({ opus_path: `${dir}/track-2.nonexistent.opus` });
  });

  test("файл отдаётся целиком", async () => {
    const res = await app.handle(new Request("http://localhost/audio/track-2"));
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(100);
  });

  test("Range ходит", async () => {
    const res = await app.handle(
      new Request("http://localhost/audio/track-2", { headers: { Range: "bytes=0-9" } }),
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("0123456789");
  });

  test("файл отсутствует на диске — 404, не падение", async () => {
    const { status, body } = await getJson("/audio/track-1");
    expect(status).toBe(404);
    expect(body.error).toContain("отсутствует");
  });

  test("несуществующее название route — единый формат ошибки", async () => {
    const res = await app.handle(new Request("http://localhost/нет-маршрута"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(typeof body.error).toBe("string");
  });
});

describe("миграция cover_path", () => {
  test("колонка есть после migrate.latest", async () => {
    const info = (await db.raw("pragma table_info(tracks)")) as Array<{ name: string }>;
    expect(info.map((c) => c.name)).toContain("cover_path");
  });
});

describe("DELETE /tracks/:id", () => {
  test("существующий трек: строка удалена, файлы стёрты", async () => {
    // Настоящие файлы на диске — DELETE отвечает и за них. Пути он берёт
    // из БД: opus_path и cover_path.
    const opusPath = join(dir, "track-2.opus");
    const coverPath = join(dir, "track-2-cover.jpg");
    await writeFile(opusPath, "opus-bytes");
    await writeFile(coverPath, "cover-bytes");
    await db("tracks").where("id", "track-2").update({
      opus_path: opusPath,
      cover_path: coverPath,
      ext: "mp3",
    });

    const { status, body } = await deleteJson("track-2");
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, id: "track-2" });

    const gone = await app.handle(new Request("http://localhost/tracks/track-2"));
    expect(gone.status).toBe(404);
    const { body: after } = await getJson("/tracks");
    expect(after.total).toBe(FIXTURES.length - 1);
    expect(ids(after)).not.toContain("track-2");
    for (const p of [opusPath, coverPath]) {
      expect(await Bun.file(p).exists()).toBe(false);
    }
  });

  test("трек без обложки: opus стёрт", async () => {
    const opusPath = join(dir, "track-5.opus");
    await writeFile(opusPath, "opus-bytes");
    await db("tracks").where("id", "track-5").update({
      ext: "wav",
      opus_path: opusPath,
      cover_path: null,
    });

    const { status } = await deleteJson("track-5");
    expect(status).toBe(200);
    expect(await Bun.file(opusPath).exists()).toBe(false);
  });

  test("несуществующий трек: 404 в едином формате", async () => {
    const { status, body } = await deleteJson("нет-такого");
    expect(status).toBe(404);
    expect(body.error).toBe("трек не найден");
  });

  test("удаление не задевает соседей", async () => {
    const { body } = await getJson("/tracks?sort=created&order=asc");
    expect(ids(body)).toEqual(["track-3", "track-1", "track-4"]);
  });
});

async function playJson(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.handle(new Request(`http://localhost/tracks/${id}/play`, { method: "POST" }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /tracks/:id/play", () => {
  test("никогда не игравший трек: штамп и счётчик с нуля", async () => {
    const before = await getJson("/tracks/track-1");
    expect(before.body.lastPlayed).toBeNull();
    expect(before.body.playCount).toBe(0);

    const r1 = await playJson("track-1");
    expect(r1.status).toBe(200);
    expect(typeof r1.body.lastPlayed).toBe("string");
    expect(r1.body.playCount).toBe(1);

    // Повторное признание того же трека только наращивает счётчик.
    const r2 = await playJson("track-1");
    expect(r2.body.playCount).toBe(2);
  });

  test("несуществующий трек: 404 в едином формате", async () => {
    const { status, body } = await playJson("нет-такого");
    expect(status).toBe(404);
    expect(body.error).toBe("трек не найден");
  });
});

describe("GET /tracks?sort=played", () => {
  // Свои треки и штампы: к этому моменту DELETE-тесты уже удалили пару
  // фикстур, а API-пинг ставит время от часов запуска — порядок обязан
  // быть детерминированным, поэтому всё с нуля и по рукам.
  const p1 = "sort-played-a";
  const p2 = "sort-played-b";
  const p3 = "sort-played-c";

  beforeAll(async () => {
    for (const [id, stamp] of [
      [p1, "2026-01-05 10:00:00"],
      [p2, "2026-01-04 10:00:00"],
      [p3, "2026-01-03 10:00:00"],
    ] as const) {
      await db("tracks").insert({
        id,
        filename: `${id}.mp3`,
        ext: "mp3",
        size_bytes: 100,
        opus_path: `${id}.opus`,
        title: id,
        meta_source: "none",
        created_at: "2024-02-01 10:00:00",
        last_played_at: stamp,
      });
    }
    // Реальные треки, что дожили до этих тестов, сбрасываем в «никогда»:
    // их штампы могли появиться из POST-тестов, зависящих от часов.
    await db("tracks").whereNotIn("id", [p1, p2, p3]).update({ last_played_at: null });
  });

  afterAll(async () => {
    await db("tracks").whereIn("id", [p1, p2, p3]).del();
  });

  test("desc: недавно прослушанные первыми, никогда — в конце", async () => {
    const { status, body } = await getJson("/tracks?sort=played&order=desc");
    expect(status).toBe(200);
    expect(ids(body)).toEqual([p1, p2, p3, "track-1", "track-3", "track-4"]);
  });

  test("asc: от давнего к недавнему, никогда по-прежнему в конце", async () => {
    const { body } = await getJson("/tracks?sort=played&order=asc");
    expect(ids(body)).toEqual([p3, p2, p1, "track-1", "track-3", "track-4"]);
  });
});
