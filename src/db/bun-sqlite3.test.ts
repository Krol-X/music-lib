import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Knex } from "knex";
import { bunKnex, loadExtension } from "./bun-sqlite3.js";
import { createDb } from "./index.js";

let dir: string;
let db: Knex;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "music-lib-test-"));
  db = await createDb({ connection: { filename: join(dir, "test.sqlite") } });
  await db.schema.createTable("tracks", (t) => {
    t.increments("id");
    t.string("title").notNullable();
    t.integer("bpm").nullable();
    t.string("cover").nullable();
    t.binary("embedding").nullable();
    t.timestamps(true, true);
  });
});

afterAll(async () => {
  await db.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe("схема и запись", () => {
  test("insert возвращает сгенерированный id", async () => {
    const id = await db("tracks").insert({ title: "Sunrise", bpm: 112 });
    expect(id).toEqual([1]);
  });

  test("insertMany", async () => {
    await db("tracks").insert([
      { title: "Easy", bpm: 128 },
      { title: "Held Back", bpm: 96 },
      { title: "Return to Fantasy", bpm: 74 },
    ]);
    const { c } = (await db("tracks").count({ c: "*" }).first()) as { c: number };
    expect(c).toBe(4);
  });

  test("returning() отдаёт вставленную строку", async () => {
    // Требует reader-детекта: statement.run() на RETURNING строки не возвращает.
    const rows = await db("tracks").insert({ title: "New" }).returning(["id", "title"]);
    expect(rows[0].title).toBe("New");
  });

  test("update и delete отчитываются о числе строк", async () => {
    // Явные аннотации обязательны: тяжёлые дженерики knex при выводе
    // контекстного типа схлопывают update/delete до undefined, если они
    // идут не первым выражением в блоке.
    const changed: number = await db("tracks").where("title", "New").update({ cover: "abc.jpg" });
    const row = await db("tracks").where("title", "New").first();
    expect(row.cover).toBe("abc.jpg");
    const removed: number = await db("tracks").where("title", "New").delete();
    expect(changed).toBe(1);
    expect(removed).toBe(1);
  });
});

describe("выборки", () => {
  test("whereIn / whereBetween / whereNull", async () => {
    expect(await db("tracks").whereIn("bpm", [96, 128])).toHaveLength(2);
    // 112 и 96 оба попадают в [90, 120]
    expect(await db("tracks").whereBetween("bpm", [90, 120])).toHaveLength(2);
    expect(await db("tracks").whereNull("cover")).toHaveLength(4);
  });

  test("orWhere / whereNot / like", async () => {
    expect(await db("tracks").where("bpm", 112).orWhere("bpm", 96)).toHaveLength(2);
    // NULL не проходит `not bpm = 112`, поэтому три строки, а не четыре
    expect(await db("tracks").whereNot("bpm", 112)).toHaveLength(3);
    expect(await db("tracks").where("title", "like", "E%")).toHaveLength(1);
  });

  test("orderBy + limit + offset", async () => {
    // desc: 128, 112, 96, 74, NULL -> offset 1 limit 2 => 112, 96
    const rows = await db("tracks").orderBy("bpm", "desc").limit(2).offset(1);
    expect(rows.map((r: any) => r.bpm)).toEqual([112, 96]);
  });

  test("агрегаты", async () => {
    const r = (await db("tracks").max({ m: "bpm" }).min({ n: "bpm" }).first()) as any;
    expect(r.m).toBe(128);
    expect(r.n).toBe(74);
  });

  test("db.raw", async () => {
    const res = await db.raw("select count(*) as c from tracks");
    expect(Number(res[0].c)).toBe(4);
  });

  test("db.fn.uuid() опирается на имя диалекта", async () => {
    const res = await db.raw("select " + db.fn.uuid() + " as u");
    expect(res[0].u).toContain("-");
  });
});

describe("транзакции", () => {
  test("commit", async () => {
    await db.transaction(async (trx) => {
      await trx("tracks").insert({ title: "InTrx" });
    });
    expect(await db("tracks").where("title", "InTrx")).toHaveLength(1);
  });

  test("rollback", async () => {
    // db.transaction() возвращает thenable-объект транзакции, а не промис,
    // поэтому .rejects здесь неприменим — ловим через try/catch.
    try {
      await db.transaction(async (trx) => {
        await trx("tracks").insert({ title: "Rollback" });
        throw new Error("boom");
      });
      throw new Error("транзакция не откатилась");
    } catch (e) {
      expect((e as Error).message).toBe("boom");
    }
    expect(await db("tracks").where("title", "Rollback")).toHaveLength(0);
  });
});

describe("типы значений", () => {
  test("binary round-trip под эмбеддинг", async () => {
    const vec = new Uint8Array([0, 0, 128, 63, 0, 0, 0, 0]);
    const [id] = await db("tracks").insert({ title: "Vector", embedding: Buffer.from(vec) });
    const row = await db("tracks").where("id", id).first();
    expect(Buffer.compare(Buffer.from(row.embedding), Buffer.from(vec))).toBe(0);
    expect(await db("tracks").where("embedding", Buffer.from(vec)).first()).toMatchObject({
      title: "Vector",
    });
  });

  test("Date в where", async () => {
    await db.schema.createTable("events", (t) => {
      t.increments("id");
      t.timestamp("at").notNullable();
    });
    await db("events").insert([
      { at: new Date("2026-01-02T03:04:05Z") },
      { at: new Date("2026-06-07T08:09:10Z") },
    ]);
    const row = await db("events").where("at", ">", new Date("2026-03-01T00:00:00Z")).first();
    expect(new Date(row.at as unknown as string).getUTCFullYear()).toBe(2026);
  });

  test("boolean кладётся как 1/0", async () => {
    await db.schema.createTable("flags", (t) => {
      t.increments("id");
      t.boolean("ok").notNullable();
    });
    await db("flags").insert([{ ok: true }, { ok: false }]);
    expect(await db("flags").where("ok", true).pluck("id")).toEqual([1]);
  });

  test("bigint через safeIntegers", async () => {
    await db.schema.createTable("big", (t) => {
      t.increments("id");
      t.bigInteger("n").notNullable();
    });
    const safe = bunKnex({
      connection: { filename: join(dir, "test.sqlite"), options: { safeIntegers: true } },
      useNullAsDefault: true,
    });
    await safe("big").insert({ n: "9007199254740993" });
    const row = await safe("big").first();
    expect(typeof row.n).toBe("bigint");
    expect(String(row.n)).toBe("9007199254740993");
    await safe.destroy();
  });

  test("WAL включается", async () => {
    const res = await db.raw("PRAGMA journal_mode = WAL");
    expect(res[0].journal_mode).toBe("wal");
  });

  test("пул sqlite держит одно соединение", () => {
    const client = db.client as any;
    expect(client.pool.min).toBe(1);
    expect(client.pool.max).toBe(1);
  });
});

describe("нативные расширения", () => {
  const extPath = process.env.SQLITE_VEC_PATH;

  test.skipIf(!extPath)("sqlite-vec доступен после loadExtension", async () => {
    const local = await createDb({ connection: { filename: join(dir, "vec.sqlite") } });
    await loadExtension(local, extPath!);
    await local.raw("CREATE VIRTUAL TABLE emb USING vec0(id INTEGER PRIMARY KEY, v FLOAT[4])");
    await local.raw("INSERT INTO emb(id, v) VALUES (?, ?)", [1, JSON.stringify([1, 0, 0, 0])]);
    await local.raw("INSERT INTO emb(id, v) VALUES (?, ?)", [2, JSON.stringify([0, 1, 0, 0])]);
    const rows = await local.raw(
      "SELECT id, distance FROM emb WHERE v MATCH ? AND k = ? ORDER BY distance",
      [JSON.stringify([1, 0, 0, 0]), 2],
    );
    expect(rows.map((r: any) => r.id)).toEqual([1, 2]);
    expect(rows[0].distance).toBe(0);
    await local.destroy();
  });
});
