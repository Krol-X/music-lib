import type { Knex } from "knex";

/**
 * Откуда взялись метаданные трека.
 *
 * Нужно, чтобы отличать прочитанные теги от догадок по имени файла: разбор
 * имени даёт полезную строку для рипов без тегов, но это не факт, а
 * предположение, и оно не должно выглядеть в базе так же, как настоящие
 * данные. По этой колонке такие треки потом находятся и уточняются.
 *
 *   tags      — название прочитано из тегов;
 *   filename  — названия в тегах не было, оно выведено из имени файла;
 *   none      — ни тегов, ни разбора имени не дали ничего.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tracks", (t) => {
    t.text("meta_source").nullable();
  });

  await knex.schema.alterTable("tracks", (t) => {
    // Поддержка обхода «покажи всё, что угадано» без сканирования таблицы.
    t.index("meta_source", "tracks_meta_source_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tracks", (t) => {
    t.dropIndex([], "tracks_meta_source_idx");
  });

  await knex.schema.alterTable("tracks", (t) => {
    t.dropColumn("meta_source");
  });
}
