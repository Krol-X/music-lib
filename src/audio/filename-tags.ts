import { EMPTY_TAGS, type TrackTags } from "./tags";

/**
 * Запасной источник названия: разбор имени файла, когда тегов нет.
 *
 * Нужен для рипов и файлов, скачанных без метаданных, где единственное, что
 * о названии известно, — само имя. Все догадки помечаются в `meta_source`
 * значением `filename`, поэтому их всегда можно найти и уточнить позже.
 *
 * Правило, которому подчинено всё остальное: **лучше не угадать ничего, чем
 * угадать неверно**. Ошибочный `artist` попадёт в базу неотличимым от
 * настоящего и будет мешать и поиску, и группировке. Поэтому год берётся
 * только из скобок, album и genre не выводятся никогда, а artist — только из
 * самого распространённого разделителя.
 */

export type MetaSource = "tags" | "filename" | "none";

/** Разделитель «исполнитель — название» в именах файлов. */
const SEP = " - ";

/** Год в квадратных или круглых скобках в конце имени. */
const TRAILING_YEAR = /[[(](\d{4})[\])]\s*$/;

/** Номер диска и трека в начале имени: `01-02 ` или `1-02`. */
const DISC_TRACK = /^(\d{1,2})[-.](\d{1,3})(?=\s*[._-]?\s)/;

/**
 * Просто номер трека: `01 `, `01. `, `01- `, `01_ ` и даже `01 название`
 * без знака препинания. Пробел после цифр тоже считается разделителем, иначе
 * половина имён вида `07 Sunrise.mp3` осталась бы без номера.
 */
const TRACK = /^(\d{1,3})(?:\s*[._)\-–]\s*|\s+)/;

/**
 * Убирает хвост из расширения: имя из БД хранится вместе с `.mp3`, а в
 * заголовке расширения быть не должно.
 */
function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
}

/**
 * Разбирает имя файла в теги. Возвращает только то, что удалось вывести
 * наверняка; остальные поля остаются null.
 *
 * Разбираемые соглашения:
 * - `01 - Artist - Title` → номер, исполнитель, название;
 * - `01 - Title` → номер и название, исполнитель не выдумывается;
 * - `01. Title`, `01 Title` → номер и название;
 * - `01-02 - Title` → диск, номер, название;
 * - `Title [1999]` → название и год;
 * - `Title` → только название.
 */
export function parseFilename(name: string): TrackTags {
  const tags: TrackTags = { ...EMPTY_TAGS };
  let rest = stripExtension(name).trim();
  if (rest === "") return tags;

  const year = TRAILING_YEAR.exec(rest);
  if (year) {
    const value = Number(year[1]);
    if (value >= 1000 && value <= 3000) tags.year = value;
    rest = rest.slice(0, year.index).trim();
  }

  const discTrack = DISC_TRACK.exec(rest);
  if (discTrack) {
    tags.discNo = Number(discTrack[1]);
    tags.trackNo = Number(discTrack[2]);
    rest = rest.slice(discTrack[0].length).replace(/^[._\-\s]+/, "").trim();
  } else {
    const track = TRACK.exec(rest);
    if (track) {
      tags.trackNo = Number(track[1]);
      rest = rest.slice(track[0].length).trim();
    }
  }

  if (rest === "") return tags;

  const parts = rest.split(SEP).map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 2) {
    // Ровно два куска — самое частое соглашение: исполнитель и название.
    tags.artist = parts[0];
    tags.title = parts[1];
  } else if (parts.length > 0) {
    // Три и более кусков неоднозначны: это может быть «Исполнитель - Название -
    // Live» или название с дефисами. Исполнителя не берём, название оставляем
    // целиком. Один кусок — то же самое, только без склейки.
    const title = parts.join(SEP);
    // Сплошные цифры — это номер, а не название: не превращаем «1234» в трек
    // с названием «1234». Лучше не угадать, чем угадать неверно.
    if (!/^\d+$/.test(title)) tags.title = title;
  }

  return tags;
}

/**
 * Читает теги, а если в них нет названия, добавляет догадки из имени файла.
 * Настоящие теги всегда побеждают: догадка заполняет только пустое.
 *
 * Порог для вмешательства именно `title`, а не «хоть одно поле пустое».
 * Название — то, по чему трек опознают, и если оно есть, трогать метаданные
 * незачем: artist из имени файла в половине случаев окажется мусором, который
 * потом придётся вычищать.
 *
 * Возвращает источник данных, который и записывается в `meta_source`.
 */
export function resolveTags(
  tagged: TrackTags,
  filename: string,
): { tags: TrackTags; source: MetaSource } {
  if (tagged.title !== null) return { tags: tagged, source: "tags" };

  const guessed = parseFilename(filename);
  // Заполняются только пустые поля: теги главнее.
  const merged: TrackTags = {
    title: guessed.title,
    artist: tagged.artist ?? guessed.artist,
    album: tagged.album,
    genre: tagged.genre,
    year: tagged.year ?? guessed.year,
    trackNo: tagged.trackNo ?? guessed.trackNo,
    trackTotal: tagged.trackTotal ?? guessed.trackTotal,
    discNo: tagged.discNo ?? guessed.discNo,
    discTotal: tagged.discTotal ?? guessed.discTotal,
  };

  if (merged.title === null) {
    const fallback = stripExtension(filename).trim();
    if (fallback !== "") {
      merged.title = fallback;
      return { tags: merged, source: "filename" };
    }
    return { tags: merged, source: "none" };
  }
  const usedGuess = Object.keys(guessed).some(
    (key) => guessed[key as keyof TrackTags] !== null && tagged[key as keyof TrackTags] === null,
  );
  return { tags: merged, source: usedGuess ? "filename" : "tags" };
}
