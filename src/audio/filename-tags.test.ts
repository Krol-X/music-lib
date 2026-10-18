import { describe, expect, test } from "bun:test";
import { parseFilename, resolveTags } from "./filename-tags";
import { EMPTY_TAGS, normalizeTags } from "./tags";

describe("разбор имени файла", () => {
  test("полное соглашение NN - Исполнитель - Название", () => {
    expect(parseFilename("01 - Uriah Heep - Sunrise.mp3")).toMatchObject({
      trackNo: 1,
      artist: "Uriah Heep",
      title: "Sunrise",
    });
  });

  test("двузначный номер", () => {
    expect(parseFilename("12 - Artist - Title.mp3").trackNo).toBe(12);
  });

  test("номер с точкой", () => {
    expect(parseFilename("03. Sunrise.mp3")).toMatchObject({ trackNo: 3, title: "Sunrise" });
  });

  test("номер с точкой и исполнитель", () => {
    expect(parseFilename("03. Artist - Sunrise.mp3")).toMatchObject({
      trackNo: 3,
      artist: "Artist",
      title: "Sunrise",
    });
  });

  test("номер без разделителя", () => {
    expect(parseFilename("07 Sunrise.mp3")).toMatchObject({ trackNo: 7, title: "Sunrise" });
  });

  test("номер и название без исполнителя", () => {
    // Исполнителя нет, а выдумывать его нельзя.
    expect(parseFilename("01 - Sunrise.mp3")).toMatchObject({ trackNo: 1, title: "Sunrise" });
    expect(parseFilename("01 - Sunrise.mp3").artist).toBeNull();
  });

  test("без номера: только исполнитель и название", () => {
    expect(parseFilename("Uriah Heep - Sunrise.mp3")).toMatchObject({
      artist: "Uriah Heep",
      title: "Sunrise",
    });
  });

  test("многодисковое издание", () => {
    expect(parseFilename("01-02 - Sunrise.mp3")).toMatchObject({
      discNo: 1,
      trackNo: 2,
      title: "Sunrise",
    });
  });

  test("год в скобках в конце", () => {
    expect(parseFilename("Sunrise [1973].mp3")).toMatchObject({
      title: "Sunrise",
      year: 1973,
    });
  });

  test("год в круглых скобках", () => {
    expect(parseFilename("Sunrise (Live 1999).mp3")).toMatchObject({
      title: "Sunrise (Live 1999)",
    });
  });

  test("год в скобках вместе со всем остальным", () => {
    expect(parseFilename("05 - Artist - Sunrise [1973].mp3")).toMatchObject({
      trackNo: 5,
      artist: "Artist",
      title: "Sunrise",
      year: 1973,
    });
  });

  test("неправдоподобный год в скобках игнорируется", () => {
    expect(parseFilename("Sunrise [0042].mp3").year).toBeNull();
    expect(parseFilename("Sunrise [0042].mp3").title).toBe("Sunrise");
  });

  test("расширение не попадает в название", () => {
    expect(parseFilename("Sunrise.flac").title).toBe("Sunrise");
    expect(parseFilename("Sunrise.opus").title).toBe("Sunrise");
  });

  test("пустое имя даёт пустые теги", () => {
    expect(parseFilename("")).toEqual(EMPTY_TAGS);
    expect(parseFilename("   ")).toEqual(EMPTY_TAGS);
  });
});

describe("разбор не выдумывает", () => {
  test("album и genre из имени не выводятся никогда", () => {
    const t = parseFilename("01 - Uriah Heep - Look at Yourself - Hard Rock - 1973.mp3");
    expect(t.album).toBeNull();
    expect(t.genre).toBeNull();
  });

  test("название с дефисом не разрывается на исполнителя и трек", () => {
    // Три куска неоднозначны, поэтому исполнитель не выделяется.
    const t = parseFilename("Pink Floyd - A - B.mp3");
    expect(t.artist).toBeNull();
    expect(t.title).toBe("Pink Floyd - A - B");
  });

  test("многозначный номер не превращается в номер трека", () => {
    // 1234 — не номер трека, а часть названия.
    expect(parseFilename("1234 Reasons.mp3").trackNo).toBeNull();
    expect(parseFilename("1234 Reasons.mp3").title).toBe("1234 Reasons");
  });

  test("номер ограничен тремя цифрами", () => {
    expect(parseFilename("999 - Title.mp3").trackNo).toBe(999);
  });
});

describe("слияние с тегами", () => {
  test("есть название в тегах — догадки не трогают ничего", () => {
    const tagged = normalizeTags({ title: "Sunrise", artist: "Uriah Heep" });
    const { tags, source } = resolveTags(tagged, "99 - Someone Else - Wrong.mp3");
    expect(tags).toEqual(tagged);
    expect(source).toBe("tags");
  });

  test("название только из имени файла помечается как filename", () => {
    const { tags, source } = resolveTags(EMPTY_TAGS, "03 - Artist - Sunrise.mp3");
    expect(tags).toMatchObject({ trackNo: 3, artist: "Artist", title: "Sunrise" });
    expect(source).toBe("filename");
  });

  test("исполнитель из тегов переживает догадку о названии", () => {
    // Тег есть, названия нет: имя файла даёт название, тег даёт исполнителя.
    const tagged = normalizeTags({ artist: "Uriah Heep", album: "Look at Yourself" });
    const { tags, source } = resolveTags(tagged, "03 - Wrong Artist - Sunrise.mp3");
    expect(tags.artist).toBe("Uriah Heep");
    expect(tags.album).toBe("Look at Yourself");
    expect(tags.title).toBe("Sunrise");
    expect(source).toBe("filename");
  });

  test("год из тегов не перебивается годом из имени", () => {
    const tagged = normalizeTags({ artist: "A", year: 1999 });
    const { tags } = resolveTags(tagged, "Sunrise [1973].mp3");
    expect(tags.year).toBe(1999);
  });

  test("неугадываемое имя получает название из имени файла", () => {
    // Голое имя из цифр или без шаблона всё равно получает имя файла без расширения как название
    const res1234 = resolveTags(EMPTY_TAGS, "1234");
    expect(res1234.source).toBe("filename");
    expect(res1234.tags.title).toBe("1234");

    const res05 = resolveTags(EMPTY_TAGS, "05 -.mp3");
    expect(res05.source).toBe("filename");
    expect(res05.tags.title).toBe("05 -");

    // При полностью пустом имени файла источник none
    expect(resolveTags(EMPTY_TAGS, "").source).toBe("none");
  });

  test("источник tags ставится, даже если из имени ничего не взято", () => {
    const tagged = normalizeTags({ title: "Sunrise" });
    expect(resolveTags(tagged, "Sunrise.mp3").source).toBe("tags");
  });
});
