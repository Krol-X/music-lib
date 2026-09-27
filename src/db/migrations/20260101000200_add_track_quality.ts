import type { Knex } from "knex";

/**
 * Что удалось выяснить про исходник. Заполняется при загрузке модулем
 * src/audio/quality.ts.
 *
 * Поля nullable, а не с DEFAULT: у части коллекции значения ещё нет, и пустое
 * «не измерено» полезнее, чем выдуманный ноль.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tracks", (t) => {
    // Средний битрейт исходника, кбит/с. Потолок качества, а не гарантия.
    t.integer("bitrate_kbps").nullable();
    // MP3 переменного битрейта. null, если файл не MP3.
    t.boolean("vbr").nullable();
    // CBR / ABR / VBR — из LAME-тега.
    t.text("vbr_method").nullable();
    // Строка кодировщика: LAME3.100, Lavc60, ...
    t.text("encoder").nullable();
    t.integer("duration_sec").nullable();
    // Главное поле: частота, выше которой в исходнике уже нет содержания.
    // Замер по спектру, а не по заявленному битрейту: так видно и
    // перекодированный 320k, у которого верх обрезан по исходнику.
    t.integer("cutoff_hz").nullable();
    // Какой битрейт Opus в итоге выбран под cutoff_hz.
    t.text("opus_bitrate").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tracks", (t) => {
    t.dropColumn("bitrate_kbps");
    t.dropColumn("vbr");
    t.dropColumn("vbr_method");
    t.dropColumn("encoder");
    t.dropColumn("duration_sec");
    t.dropColumn("cutoff_hz");
    t.dropColumn("opus_bitrate");
  });
}
