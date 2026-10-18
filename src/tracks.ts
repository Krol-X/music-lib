import type { Knex } from "knex";

/**
 * Чтение и точечная правка треков.
 *
 * Логика отдаёт строки в виде, пригодном для JSON, и делает всю работу с
 * фильтрами, сортировками и пагинацией. Маршруты в index.ts остаются
 * тонкими: распарсить query и передать сюда.
 *
 * Отдельные таблицы albums/artists не заводим: у приватной библиотеки
 * размер таков, что джойны не окупаются (пояснение в README). Фильтры по
 * текстовым колонкам дорогие, но уже покрыты индексами, построенными
 * под это же использование.
 */

export type TrackRow = Record<string, unknown>;

/** Источник метаданных: как в filename-tags.ts, плюс то, что человек ввёл сам. */
export type TrackMetaSource = "tags" | "filename" | "none" | "edited";

/**
 * Строка трека в формате API. Внутренние пути (opus_path, cover_path) не
 * отдаются: клиенту нужны не пути на диске сервера, а URL маршрутов.
 *
 * sqlite отдаёт boolean как 0/1 и время как "YYYY-MM-DD HH:MM:SS", поэтому
 * оба поля приводятся к тому, что знает Date любого языка: ISO-время с Z.
 * CURRENT_TIMESTAMP в sqlite — UTC, так что суффикс Z не врёт о таймзоне.
 */
export function trackToJson(row: TrackRow): Record<string, unknown> {
  const id = String(row.id);
  return {
    id,
    filename: row.filename,
    ext: row.ext,
    audioUrl: `/audio/${id}`,
    coverUrl: row.cover_path ? `/cover/${id}` : null,
    sizeBytes: row.size_bytes,
    durationSec: row.duration_sec,
    bitrateKbps: row.bitrate_kbps,
    vbr: row.vbr === null || row.vbr === undefined ? null : Boolean(row.vbr),
    vbrMethod: row.vbr_method,
    encoder: row.encoder,
    cutoffHz: row.cutoff_hz,
    opusBitrate: row.opus_bitrate,
    title: row.title,
    artist: row.artist,
    album: row.album,
    genre: row.genre,
    year: row.year,
    trackNo: row.track_no,
    trackTotal: row.track_total,
    discNo: row.disc_no,
    discTotal: row.disc_total,
    metaSource: row.meta_source,
    lastPlayed: isoTimestamp(row.last_played_at),
    playCount: row.play_count,
    createdAt: isoTimestamp(row.created_at),
  };
}

/**
 * Факт прослушивания: мост диалог только после 30 сек реального звучания,
 * здесь только штамп. Счётчик — сколько раз трек переходил порог.
 * Кто прослушал — решает клиент; сервер не считает ключевую позицию сам,
 * ему не суждено знать, слушал ли человек вообще.
 */
export async function markTrackPlayed(
  db: Knex,
  id: string,
  durationSec?: number | null,
): Promise<Record<string, unknown> | null> {
  const row = await db("tracks").where("id", id).first();
  if (!row) return null;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const update: Record<string, string | number | Knex.Raw> = {
    last_played_at: now,
    play_count: db.raw("play_count + 1"),
  };
  // Мост знает фактическую длину лучше, чем пустая строка БД у рипов без
  // тегов: разовый fill — потом правится руками как любое поле.
  if ((row.duration_sec === null || row.duration_sec === undefined)
    && typeof durationSec === "number" && durationSec >= 1 && durationSec <= 86400) {
    update.duration_sec = Math.round(durationSec);
  }
  await db("tracks").where("id", id).update(update);
  return trackToJson(await db("tracks").where("id", id).first());
}

/** sqlite "2026-01-17 13:33:42" → ISO "2026-01-17T13:33:42Z"; Date → ISO. */
function isoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return `${value.slice(0, 10)}T${value.slice(11)}Z`;
  }
  return value === null || value === undefined ? null : String(value);
}

/** Поля, выдача которых выйдет в поиск при наличии поля q */
const SEARCH_COLUMNS = [`title`, `artist`, `album`, `genre`] as const;

const SORTABLE: Record<string, { column: string; nullable: boolean }> = {
  created: { column: "created_at", nullable: false },
  title: { column: "title", nullable: true },
  artist: { column: "artist", nullable: true },
  album: { column: "album", nullable: true },
  year: { column: "year", nullable: true },
  duration: { column: "duration_sec", nullable: true },
  played: { column: "last_played_at", nullable: true },
};

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

function parseLimit(value: string | null | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  // Клиент может попросить "ну скинь мне все треки разом": потолок нужен
  // не для защиты, а чтобы виджет на 10 тысячах треков не завис.
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function parseOffset(value: string | null | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Клонирует условия выборки, чтобы сосчитать total без limit/offset. */
function applyFilters(
  query: Knex.QueryBuilder<TrackRow, unknown>,
  filters: {
    q?: string | null;
    artist?: string | null;
    album?: string | null;
    genre?: string | null;
  },
): void {
  if (filters.artist) query.whereRaw(`lower(artist) = lower(?)`, [filters.artist]);
  if (filters.album) query.whereRaw(`lower(album) = lower(?)`, [filters.album]);
  if (filters.genre) query.whereRaw(`lower(genre) = lower(?)`, [filters.genre]);

  if (filters.q) {
    const like = `%${filters.q.replace(/\\|[%_]/g, (s) => `\\${s}`)}%`;
    query.where((builder) => {
      for (const column of SEARCH_COLUMNS) {
        builder.orWhereRaw(`lower(${column}) like lower(?) escape '\\'`, [like]);
      }
    });
  }
}

/**
 * Список треков: пагинация limit/offset (с потолком), поиск q по title,
 * artist, album, фильтры artist/album/genre (точное совпадение без учёта
 * регистра), сортировка по одному из SORTABLE с null в самом конце.
 *
 * Сортировка по album включает весь составной ключ: artist → album →
 * disc → track. Если позволить сортировать только по album, сообщения
 * "01 Track" раскидаются по всем альбомам с тем же названием в хаотичный
 * порядок, определяемый id.
 *
 * Поиск q ищет подстрокой без возможности инверсии: чтобы "Elvis" находил
 * "Elvis Presley", полнотекстовый индекс не нужен у треков такого объёма.
 */
export async function listTracks(
  db: Knex,
  params: {
    q?: string | null;
    artist?: string | null;
    album?: string | null;
    genre?: string | null;
    sort?: string | null;
    order?: string | null;
    limit?: string | null;
    offset?: string | null;
  },
): Promise<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
  const limit = parseLimit(params.limit);
  const offset = parseOffset(params.offset);
  const sortKey = params.sort && SORTABLE[params.sort] !== undefined ? params.sort : "created";
  const sort = SORTABLE[sortKey];
  const order = params.order === "asc" ? "asc" : "desc";

  const base = () => {
    const query = db<TrackRow>("tracks");
    applyFilters(query, params);
    return query;
  };

  // Колонки, содержащие null, ставятся в конец выборки. Без этого пустые
  // title оказываются первыми при сортировке asc. Выражения построены только
  // из SORTABLE и order — пользовательского текста тут нет, инъекции не в чём.
  const direction = order.toUpperCase();
  const orderBy =
    sortKey === "album"
      ? // Составной ключ из индекса tracks_album_order_idx: «альбом, внутри
        // трек», порядок не должен зависеть от id.
        `(artist IS NULL), artist ${direction}, (album IS NULL), album ${direction}, ` +
        `(disc_no IS NULL), disc_no, (track_no IS NULL), track_no`
      : sort.nullable
        ? `(${sort.column} IS NULL), ${sort.column} ${direction}`
        : `${sort.column} ${direction}`;

  const [countRow] = await base().count({ total: "*" });
  const total = Number((countRow as { total: number | string }).total);

  const rows = await base().orderByRaw(orderBy).select().limit(limit).offset(offset);

  return { items: rows.map(trackToJson), total, limit, offset };
}

export interface PatchBody {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  trackNo?: number;
  trackTotal?: number;
  discNo?: number;
  discTotal?: number;
}

const MAX_TEXT = 1000;

function textPatch(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_TEXT);
}

function yearPatch(value: number | null): number | null {
  // Тот же диапазон, что в tags.ts: 1000 — не год пластинки, 3000 — опечатка.
  if (value !== null && !(value >= 1000 && value <= 3000)) {
    throw new RangeError("год вне диапазона");
  }
  return value;
}

/**
 * Приводит тело PATCH к колонкам. Речь про точечную правку треков с
 * meta_source = filename — у рипов artist взят из догадки по имени файла,
 * и его хочется подтвердить или вычистить. Правка трека с meta_source = tags
 * тоже разрешена: человек лучше тега.
 *
 * Пустая строка — это способ очистить поле: пустое название не имеет смысла,
 * а отдельный "обнулить" флаг усложняет API. После правки meta_source
 * становится edited: пользовательский ввод — уже не догадка из имени файла,
 * но и не прочитанные теги, хочётся сохранить происхождение честно.
 */
export function patchToColumns(body: PatchBody): Record<string, string | number | null> {
  const columns: Record<string, string | number | null> = {};
  for (const key of ["title", "artist", "album", "genre"] as const) {
    if (body[key] !== undefined) columns[key] = textPatch(body[key]!);
  }
  if (body.year !== undefined) columns["year"] = yearPatch(body.year);
  for (const [column, value] of [["track_no", body.trackNo], ["track_total", body.trackTotal],
    ["disc_no", body.discNo], ["disc_total", body.discTotal]] as const) {
    if (value !== undefined) columns[column] = value;
  }
  return columns;
}
