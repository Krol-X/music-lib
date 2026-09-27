import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tracks", (t) => {
    // SHA-256 исходного файла. Один и тот же файл всегда даёт один и тот же
    // id, поэтому повторная загрузка бесплатно дедуплицируется, а перекодирование
    // в другой битрейт не ломает ссылку.
    t.text("id").primary();
    t.text("filename").notNullable();
    t.text("ext").notNullable();
    t.integer("size_bytes").notNullable();
    // Аудио живёт по конвенции storage/converted/{id}.opus, но путь хранится
    // явно: чтение не должно собирать его конкатенацией.
    t.text("opus_path").notNullable();
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.alterTable("tracks", (t) => {
    t.index("created_at", "tracks_created_at_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("tracks");
}
