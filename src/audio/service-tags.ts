/**
 * Кастомные теги с префиксом MUSICLIB_.
 *
 * Функция выросла из ручной инспекции файлов и осталась полезной: свой тег
 * в собственном формате — это единственный способ хранить рядом с аудио
 * то, чего нет в стандартных полях (свои плейлисты, оценки, флаги).
 *
 * `meta.common` у music-metadata содержит только известные Vorbis-поля,
 * поэтому кастомные ключи лежат в `meta.native`.
 */
export function serviceTags(meta: { native: Record<string, unknown> }): Record<string, string> {
  const out: Record<string, string> = {};

  for (const tags of Object.values(meta.native)) {
    if (!Array.isArray(tags)) continue;

    for (const tag of tags as { id: string; value: unknown }[]) {
      if (tag && typeof tag.id === "string" && tag.id.startsWith("MUSICLIB_")) {
        out[tag.id] = String(tag.value);
      }
    }
  }

  return out;
}