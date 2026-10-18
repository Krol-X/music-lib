/**
 * Учёт прослушивания: когда трек играл в последний раз и сколько раз.
 *
 * Хранится на сервере, хотя решает клиент: сортировка «по последнему
 * прослушанному» должна выполняться на стороне /tracks, а единственный
 * клиент, который знает о факте прослушивания, — MPRIS-мост. Он честно
 * признаёт трек прослушанным только после 30 секунд реального звучания
 * (POST /tracks/:id/play), сервер затем лишь ставит штамп времени.
 *
 * playback-состояние (пауза, позиция, резюм) остаётся на клиенте — здесь
 * только метаданные, как и остальная строка трека.
 */
import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tracks", (t) => {
    t.timestamp("last_played_at").nullable().defaultTo(null);
    t.integer("play_count").notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tracks", (t) => {
    t.dropColumn("last_played_at");
    t.dropColumn("play_count");
  });
}
