import { describe, expect, test } from "bun:test";
import { parseRange } from "./range";

const SIZE = 1000;

describe("Range: явные границы", () => {
  test("bytes=0-499 отдаёт ровно 500 байт", () => {
    expect(parseRange("bytes=0-499", SIZE)).toEqual({ start: 0, end: 499 });
  });

  test("границы включаются в ответ", () => {
    const r = parseRange("bytes=100-199", SIZE);
    expect(r).toEqual({ start: 100, end: 199 });
  });

  test("пробелы вокруг диапазона допустимы", () => {
    expect(parseRange("bytes= 0-9 ", SIZE)).toEqual({ start: 0, end: 9 });
  });
});

describe("Range: открытая правая граница", () => {
  test("bytes=500- идёт до конца файла", () => {
    expect(parseRange("bytes=500-", SIZE)).toEqual({ start: 500, end: 999 });
  });

  test("bytes=0- это весь файл", () => {
    expect(parseRange("bytes=0-", SIZE)).toEqual({ start: 0, end: 999 });
  });
});

describe("Range: суффикс", () => {
  test("bytes=-200 это последние 200 байт", () => {
    expect(parseRange("bytes=-200", SIZE)).toEqual({ start: 800, end: 999 });
  });

  test("суффикс длиннее файла обрезается до целого", () => {
    expect(parseRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  test("bytes=-0 не имеет смысла", () => {
    expect(parseRange("bytes=-0", SIZE)).toBe("unsatisfiable");
  });
});

describe("Range: выход за границы файла", () => {
  test("начало за концом файла — 416", () => {
    expect(parseRange("bytes=1000-", SIZE)).toBe("unsatisfiable");
    expect(parseRange("bytes=5000-6000", SIZE)).toBe("unsatisfiable");
  });

  test("правая граница за концом файла обрезается", () => {
    expect(parseRange("bytes=900-5000", SIZE)).toEqual({ start: 900, end: 999 });
  });

  test("правая граница левее левой — 416", () => {
    expect(parseRange("bytes=500-100", SIZE)).toBe("unsatisfiable");
  });

  test("пустой файл не отдаёт никаких байтов", () => {
    expect(parseRange("bytes=0-10", 0)).toBe("unsatisfiable");
  });

  test("единственный байт файла отдаётся целиком", () => {
    expect(parseRange("bytes=0-", 1)).toEqual({ start: 0, end: 0 });
  });
});

describe("Range: что игнорируем", () => {
  test("заголовка нет — отдаём целиком", () => {
    expect(parseRange(null, SIZE)).toBeNull();
  });

  test("неизвестная единица измерения — целиком", () => {
    expect(parseRange("items=0-10", SIZE)).toBeNull();
  });

  test("несколько диапазонов — целиком", () => {
    expect(parseRange("bytes=0-99,200-299", SIZE)).toBeNull();
  });

  test("мусор в значении — целиком", () => {
    expect(parseRange("bytes=abc-def", SIZE)).toBeNull();
    expect(parseRange("bytes=", SIZE)).toBeNull();
    expect(parseRange("bytes=-", SIZE)).toBeNull();
  });

  test("регистр единицы измерения не важен", () => {
    expect(parseRange("BYTES=0-9", SIZE)).toEqual({ start: 0, end: 9 });
  });
});
