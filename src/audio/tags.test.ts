import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_TAGS, normalizeTags, readTags, repairCyrillic, toColumns } from "./tags";

let dir = "";

async function ffmpeg(args: string[]) {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", ...args, "-y"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffmpeg завершился с кодом ${code}`);
}

const files: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "musiclib-tags-"));

  const source = join(dir, "source.wav");
  await ffmpeg([
    "-f", "lavfi",
    "-i", "anoisesrc=color=pink:duration=6:sample_rate=44100:amplitude=0.4",
    "-c:a", "pcm_s16le",
    source,
  ]);

  files.full = join(dir, "full.mp3");
  await ffmpeg([
    "-i", source,
    "-c:a", "libmp3lame", "-b:a", "192k",
    "-metadata", "title=Sunrise",
    "-metadata", "artist=Uriah Heep",
    "-metadata", "album=Look at Yourself",
    "-metadata", "genre=Hard Rock",
    "-metadata", "date=1973",
    "-metadata", "track=3/12",
    "-id3v2_version", "3",
    files.full,
  ]);

  // Без единого тега: обычное дело для файлов, вытащенных из интернета.
  files.bare = join(dir, "bare.mp3");
  await ffmpeg(["-i", source, "-c:a", "libmp3lame", "-b:a", "128k", files.bare]);

  // Не аудио вовсе: тегов нет и быть не может, а читать всё равно нельзя.
  files.notAudio = join(dir, "notaudio.mp3");
  await Bun.write(files.notAudio, "текст вместо звука\n");
});

afterAll(async () => {
  await Bun.$`rm -rf ${dir}`.quiet();
});

describe("нормализация", () => {
  test("полный набор тегов раскладывается по полям", () => {
    expect(
      normalizeTags({
        title: "Sunrise",
        artists: ["Uriah Heep"],
        album: "Look at Yourself",
        genre: ["Hard Rock"],
        year: 1973,
        track: { no: 3, of: 12 },
        disk: { no: 1, of: 2 },
      }),
    ).toEqual({
      title: "Sunrise",
      artist: "Uriah Heep",
      album: "Look at Yourself",
      genre: "Hard Rock",
      year: 1973,
      trackNo: 3,
      trackTotal: 12,
      discNo: 1,
      discTotal: 2,
    });
  });

  test("пустой объект даёт все null", () => {
    expect(normalizeTags({})).toEqual(EMPTY_TAGS);
  });

  test("отсутствие тегов вообще даёт все null", () => {
    expect(normalizeTags(undefined)).toEqual(EMPTY_TAGS);
  });

  test("несколько жанров склеиваются в порядке тега", () => {
    expect(normalizeTags({ genre: ["Rock", "Prog"] }).genre).toBe("Rock, Prog");
  });

  test("жанр-строка тоже принимается", () => {
    expect(normalizeTags({ genre: "Rock" as unknown as string[] }).genre).toBe("Rock");
  });

  test("несколько исполнителей склеиваются, а не теряются", () => {
    expect(normalizeTags({ artists: ["A feat. B", "C"] }).artist).toBe("A feat. B, C");
  });

  test("artist подхватывается, если artists пуст", () => {
    expect(normalizeTags({ artists: [], artist: "Solo" }).artist).toBe("Solo");
  });

  test("пустая строка это отсутствие, а не значение", () => {
    expect(normalizeTags({ title: "", album: "   " })).toMatchObject({
      title: null,
      album: null,
    });
  });

  test("пробелы по краям убираются", () => {
    expect(normalizeTags({ title: "  Sunrise  " }).title).toBe("Sunrise");
  });

  test("мусорные нули в теге вычищаются", () => {
    expect(normalizeTags({ title: "Sun\0rise" }).title).toBe("Sunrise");
  });
});

describe("год", () => {
  test("берётся из поля year", () => {
    expect(normalizeTags({ year: 1973 }).year).toBe(1973);
  });

  test("достаётся из даты, если year нет", () => {
    expect(normalizeTags({ date: "1973-06-01T00:00:00Z" }).year).toBe(1973);
  });

  test("год из даты вне разумного диапазона игнорируется", () => {
    expect(normalizeTags({ date: "0042-01-01" }).year).toBeNull();
    expect(normalizeTags({ date: "3001-01-01" }).year).toBeNull();
  });

  test("поле year важнее даты", () => {
    expect(normalizeTags({ year: 1999, date: "1973-01-01" }).year).toBe(1999);
  });

  test("мусорная дата не превращается в год", () => {
    expect(normalizeTags({ date: "вчера" }).year).toBeNull();
  });
});

describe("номера треков", () => {
  test("отсутствующие номера это null, а не ноль", () => {
    expect(normalizeTags({ track: { no: null, of: null } })).toMatchObject({
      trackNo: null,
      trackTotal: null,
    });
  });

  test("track без поля of читается как частичный", () => {
    expect(normalizeTags({ track: { no: 5, of: null } }).trackNo).toBe(5);
  });

  test("ненаконечные числа отбрасываются", () => {
    const bad = { no: Number.NaN, of: Number.POSITIVE_INFINITY };
    expect(normalizeTags({ track: bad }).trackNo).toBeNull();
    expect(normalizeTags({ track: bad }).trackTotal).toBeNull();
  });
});

describe("слишком длинный тег", () => {
  test("обрезается, чтобы не тащить в базу мусор", () => {
    const title = normalizeTags({ title: "x".repeat(5000) }).title!;
    expect(title).toHaveLength(1000);
  });
});

describe("отображение в колонки", () => {
  test("имена полей совпадают с колонками БД", () => {
    // Спред ...tags давал бы trackNo вместо track_no, и падало бы только в
    // момент вставки. Этот тест ловит расхождение сразу.
    expect(Object.keys(toColumns(EMPTY_TAGS)).sort()).toEqual([
      "album",
      "artist",
      "disc_no",
      "disc_total",
      "genre",
      "title",
      "track_no",
      "track_total",
      "year",
    ]);
  });

  test("в колонки не попадает ни одно поле в camelCase", () => {
    const camel = [/\b[a-z]+[A-Z]/];
    for (const key of Object.keys(toColumns(EMPTY_TAGS))) {
      expect(camel.some((re) => re.test(key)), `колонка ${key} названа в camelCase`).toBe(false);
    }
  });

  test("значения переносятся без изменений", () => {
    const tags = normalizeTags({
      title: "Sunrise",
      artists: ["Uriah Heep"],
      album: "Look at Yourself",
      genre: ["Hard Rock"],
      year: 1973,
      track: { no: 3, of: 12 },
      disk: { no: 1, of: 2 },
    });
    expect(toColumns(tags)).toEqual({
      title: "Sunrise",
      artist: "Uriah Heep",
      album: "Look at Yourself",
      genre: "Hard Rock",
      year: 1973,
      track_no: 3,
      track_total: 12,
      disc_no: 1,
      disc_total: 2,
    });
  });
});

describe("чтение настоящих файлов", () => {  test("теги достаются из ID3v2.3", async () => {
    expect(await readTags(files.full)).toMatchObject({
      title: "Sunrise",
      artist: "Uriah Heep",
      album: "Look at Yourself",
      genre: "Hard Rock",
      year: 1973,
      trackNo: 3,
      trackTotal: 12,
    });
  });

  test("файл без тегов даёт все null, а не ошибку", async () => {
    expect(await readTags(files.bare)).toEqual(EMPTY_TAGS);
  });

  test("несуществующий файл не роняет загрузку", async () => {
    expect(await readTags(join(dir, "нет-такого.mp3"))).toEqual(EMPTY_TAGS);
  });

  test("не аудио не роняет загрузку", async () => {
    expect(await readTags(files.notAudio)).toEqual(EMPTY_TAGS);
  });
});

describe("repairCyrillic", () => {
  test("cp1251 mojibake починен", () => {
    // «Ругань Из-За Стены», прочитанная парсером как latin-1.
    const broken = "Ðóãàíü Èç-Çà Ñòåíû";
    expect(repairCyrillic(broken)).toBe("Ругань Из-За Стены");
  });

  test("честный латинский заголовок с диакритикой не трогаем", () => {
    expect(repairCyrillic("Motörhead")).toBe("Motörhead");
    expect(repairCyrillic("Björk Guðmundsdóttir")).toBe("Björk Guðmundsdóttir");
  });

  test("нормальная кириллица (UTF-8) проходит как есть", () => {
    const good = "Ругань Из-За Стены";
    expect(repairCyrillic(good)).toBe(good);
  });
});
