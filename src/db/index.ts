import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Knex } from "knex";
import { bunKnex, type BunKnexConfig } from "./bun-sqlite3.js";

export const DB_PATH = resolve(process.env.MUSICLIB_DB ?? "./storage/music.sqlite");

export const MIGRATIONS_DIR = resolve(import.meta.dir, "migrations");

/**
 * SQLite не создаёт недостающие директории, поэтому папку под файл БД
 * готовим заранее. Для :memory: и прочих непутевых значений mkdir не нужен.
 */
async function ensureDir(filename: string) {
  if (filename === ":memory:") return;
  await mkdir(dirname(filename), { recursive: true });
}

export async function createDb(overrides: Partial<BunKnexConfig> = {}): Promise<Knex> {
  const connection = overrides.connection ?? { filename: DB_PATH };
  if (typeof connection !== "string") await ensureDir(connection.filename ?? DB_PATH);

  return bunKnex({
    connection,
    // В sqlite нет настоящего DEFAULT, knex положит в него строку "DEFAULT".
    useNullAsDefault: true,
    migrations: { directory: MIGRATIONS_DIR },
    ...overrides,
  } as BunKnexConfig);
}

export const db: Knex = await createDb();
