import { parseBlob, parseFile } from "music-metadata";

// ВАЖНО: опция { duration: true } обязательна.
// Без неё format.duration приходит undefined (в т.ч. для Ogg/Opus),
// потому что длительность считается по granulepos последней Ogg-страницы.
const OPTS = { duration: true } as const;

/** Чтение тегов уже сохранённого файла на диске. */
export async function inspectPath(path: string) {
	const meta = await parseFile(path, OPTS);

	return {
		format: {
			container: meta.format.container,
			codec: meta.format.codec,
			duration: meta.format.duration,
			sampleRate: meta.format.sampleRate,
			bitrate: meta.format.bitrate,
			channels: meta.format.numberOfChannels,
		},
		common: meta.common,
		native: meta.native,
		cover: meta.common.picture?.[0]?.format ?? null, // mime обложки, если есть
		warnings: meta.quality.warnings,
	};
}

/** Чтение тегов прямо из аплоада, без записи на диск. */
export async function inspectUpload(file: File) {
	const meta = await parseBlob(file, OPTS);

	const { title, artist, album, track, disk, year, genre, picture } = meta.common;
	return {
		duration: meta.format.duration,
		bitrate: meta.format.bitrate,
		sampleRate: meta.format.sampleRate,
		title,
		artist,
		album,
		trackNo: track?.no ?? null,
		diskNo: disk?.no ?? null,
		year,
		genre: genre?.[0] ?? null,
		coverMime: picture?.[0]?.format ?? null,
	};
}

/**
 * Достаёт все «свои» теги с префиксом MUSICLIB_.
 * meta.common содержит только известные Vorbis-поля,
 * кастомные ключи лежат в meta.native.
 */
export function serviceTags(meta: { native: Record<string, unknown> }) {
	const out: Record<string, string> = {};

	for (const [tags] of Object.entries(meta.native)) {
		if (!Array.isArray(tags)) continue;

		for (const tag of tags as { id: string; value: unknown }[]) {
			if (tag.id.startsWith("MUSICLIB_")) out[tag.id] = String(tag.value);
		}
	}

	return out;
}
