import type { Knex } from "knex";

/**
 * Теги, прочитанные из файла модулем src/audio/tags.ts.
 *
 * Всё nullable и хранится колонками прямо в tracks, а не отдельными таблицами
 * albums/artists: у приватной библиотеки размер таков, что джойны не окупаются.
 * Нормализация понадобится, когда появится группировка альбомов и плейлисты.
 *
 * artist и genre — плоские строки, хотя в теге это списки. Первый элемент
 * списка значим сильнее всего, порядок сохранён, а разбор по исполнителям
 * в отдельную таблицу — задача на будущее.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tracks", (t) => {
    t.text("title").nullable();
    t.text("artist").nullable();
    t.text("album").nullable();
    t.text("genre").nullable();
    t.integer("year").nullable();
    // Номер трека внутри альбома и их количество: «3/12».
    t.integer("track_no").nullable();
    t.integer("track_total").nullable();
    // То же для дисков многодисковых изданий.
    t.integer("disc_no").nullable();
    t.integer("disc_total").nullable();
  });

  await knex.schema.alterTable("tracks", (t) => {
    // Сортировка по альбому, а внутри по номеру трека — типичный порядок
    // прослушивания целиком, и он не должен зависеть от id.
    t.index(["artist", "album", "disc_no", "track_no"], "tracks_album_order_idx");
    t.index("title", "tracks_title_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tracks", (t) => {
    t.dropIndex([], "tracks_album_order_idx");
    t.dropIndex([], "tracks_title_idx");
  });

  await knex.schema.alterTable("tracks", (t) => {
    t.dropColumn("title");
    t.dropColumn("artist");
    t.dropColumn("album");
    t.dropColumn("genre");
    t.dropColumn("year");
    t.dropColumn("track_no");
    t.dropColumn("track_total");
    t.dropColumn("disc_no");
    t.dropColumn("disc_total");
  });
}
