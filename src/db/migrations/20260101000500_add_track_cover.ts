import type { Knex } from "knex";

/**
 * Путь к обложке, извлечённой из тегов трека: storage/cover/{id}.{ext}.
 *
 * Хранится явно, как opus_path: чтение не должно собирать путь конкатенацией,
 * а расширение (jpg/png) зависит от картинки в тегах и заранее неизвестно.
 * Файл назван по id трека, поэтому повторная загрузка того же файла просто
 * переписывает те же байты — путь никогда не меняет содержимое.
 *
 * Null — у трека нет обложки. Половина файлов с ними, половина нет, и
 * "нет" — это обычное состояние, а не недокачанные данные.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tracks", (t) => {
    t.text("cover_path").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tracks", (t) => {
    t.dropColumn("cover_path");
  });
}
