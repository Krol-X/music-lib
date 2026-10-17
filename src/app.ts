import { mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Elysia, status, t } from "elysia";
import type { Knex } from "knex";
import { errorResponse } from "./http";
import { analyzeQuality } from "./audio/quality";
import { parseRange } from "./audio/range";
import {
  InvalidAudioError,
  checkConversion,
  inspectInput,
} from "./audio/validate";
import { readTags, toColumns, type TrackTags } from "./audio/tags";
import { extractCover, coverMime } from "./audio/cover";
import { resolveTags, type MetaSource } from "./audio/filename-tags";
import { listTracks, patchToColumns, trackToJson, type PatchBody } from "./tracks";

/**
 * Каталоги вычисляются на вызов: тесты задают MUSICLIB_STORAGE в
 * beforeAll, уже после импорта модуля, и ничего не рвётся.
 */
const storageDir = () => process.env.MUSICLIB_STORAGE ?? "./storage";
/** Как файл пришёл: для перекодирования в другой битрейт и для обложек. */
const originalDir = () => `${storageDir()}/original`;
/** Что мы отдаём на прослушивание. */
const audioDir = () => `${storageDir()}/audio`;
/** Обложки, извлечённые из тегов. */
const coverDir = () => `${storageDir()}/cover`;
/** Промежуточное: сюда ffmpeg пишет .part, отсюда rename в audio/. */
const tmpDir = () => `${storageDir()}/tmp`;

export async function ensureDirs() {
  for (const dir of [originalDir(), audioDir(), coverDir(), tmpDir()]) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * tmp/ — единственное место, где могут валяться огрызки. Стираем на старте:
 * если процесс упал посреди конвертации, .part-файлы уже никому не нужны.
 */
export async function sweepTmp() {
  await rm(tmpDir(), { recursive: true, force: true });
  await mkdir(tmpDir(), { recursive: true });
}

/**
 * ID трека = SHA-256 исходного файла. Одинаковый файл всегда даёт одинаковый
 * id, поэтому повторная загрузка бесплатно дедуплицируется, а перекодирование
 * в другой битрейт не ломает ссылку на трек.
 *
 * Хеш считается потоком по temp-файлу, а не по буферу: WebCrypto требует
 * весь файл в памяти, node:crypto — нет.
 */
async function sha256File(file: Bun.BunFile): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of file.stream()) hash.update(chunk);
  return hash.digest("hex");
}
function extOf(name: string): string {
  return (name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "bin").toLowerCase();
}

/**
 * Конвертирует в Opus через temp-файл в обе стороны: ffmpeg читает исходник с
 * диска и пишет .part прямо на диск, поэтому в памяти не оказывается ни байта
 * аудио. Итоговый файл появляется только через rename, так что оборванный
 * ffmpeg не оставит после себя нечитаемый Opus с финальным именем.
 *
 * Битрейт приходит снаружи: он выбирается по измеренному диапазону исходника,
 * а не зашит намертво. Путь результата передаётся снаружи и обязан вести в tmp/:
 * пока файл не проверен, он не имеет права стоять в audio/ под финальным
 * именем.
 *
 * Возвращает строки stderr как warnings: при -loglevel error там появляется
 * только действительно подозрительное, и проглотить такое в console.log хуже,
 * чем показать клиенту. Финальный судья всё равно checkConversion.
 */
async function convertToOpus(
  sourcePath: string,
  outputPath: string,
  bitrate: string,
): Promise<string[]> {
  // ffmpeg открывает stdout на append, поэтому старый .part надо убрать,
  // иначе повторная конвертация допишет в конец.
  await rm(outputPath, { force: true });

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel", "error",
      "-i", sourcePath,
      "-map_metadata", "0",
      "-c:a", "libopus",
      "-b:a", bitrate,
      "-vbr", "on",
      "-compression_level", "10",
      "-f", "opus",
      "pipe:1",
    ],
    { stdout: Bun.file(outputPath), stderr: "pipe" },
  );

  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;

  if (code !== 0) {
    await rm(outputPath, { force: true });
    throw new Error(`ffmpeg exited with ${code}: ${err.trim()}`);
  }

  return err.trim().length === 0 ? [] : err.trim().split("\n").map((l) => `ffmpeg: ${l}`);
}

/**
 * Отдаёт файл трека, понимая заголовок Range.
 *
 * Путь к файлу берётся из БД, а не собирается из id, поэтому подставить
 * ../../etc/passwd через параметр нельзя: id используется только как ключ
 * выборки, и несуществующий просто даёт 404.
 */
async function serveAudio(db: Knex, id: string, request: Request, withBody: boolean): Promise<Response> {
  const track = await db("tracks").where("id", id).first();
  if (!track) return errorResponse(404, "трек не найден");

  const file = Bun.file(track.opus_path as string);
  if (!(await file.exists())) return errorResponse(404, "файл аудио отсутствует на диске");

  const size = file.size;
  const range = parseRange(request.headers.get("range"), size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "audio/ogg",
    "Accept-Ranges": "bytes",
    // Не immutable: при смене политики битрейтов тот же id получит другое
    // содержимое, и кэш с иммунитетом отдал бы игроку старый файл.
    "Cache-Control": "private, max-age=3600",
  };

  if (!range) {
    headers["Content-Length"] = String(size);
    return new Response(withBody ? file : null, { status: 200, headers });
  }

  headers["Content-Length"] = String(range.end - range.start + 1);
  headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  const slice = file.slice(range.start, range.end + 1);
  return new Response(withBody ? slice : null, { status: 206, headers });
}

/**
 * Отдаёт обложку трека. Range тут не нужен: картинка маленькая, а иммунитетный
 * кэш не включаем по той же причине, что и у аудио — алгоритм извлечения может
 * поменяться, и тот же id получит другие байты.
 */
async function serveCover(db: Knex, id: string, withBody: boolean): Promise<Response> {
  const track = await db("tracks").where("id", id).first();
  if (!track) return errorResponse(404, "трек не найден");

  const coverPath = track.cover_path as string | null;
  if (!coverPath) return errorResponse(404, "у трека нет обложки");

  const file = Bun.file(coverPath);
  if (!(await file.exists())) return errorResponse(404, "файл обложки отсутствует на диске");

  return new Response(withBody ? file : null, {
    status: 200,
    headers: {
      "Content-Type": coverMime(extOf(coverPath)),
      "Content-Length": String(file.size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** Ответ загрузки: ровно то, что видит клиент. */
interface UploadResult {
  success: true;
  id: string;
  existed: boolean;
  filename: string;
  audioUrl: string;
  coverUrl: string | null;
  quality: unknown;
  tags: TrackTags;
  metaSource: MetaSource;
  warnings: string[];
}

/**
 * Весь путь файла от multipart до строки в БД.
 *
 * Вынесено из хендлера по двум причинам. Первая: выброс InvalidAudioError
 * ловится в хендлере, то есть в другой функции, — иначе получается выброс,
 * пойманный тут же, в паре строк ниже. Вторая и важнее: пока файл не прошёл
 * проверки, он лежит только в tmp/. Поэтому отказ не может удалить оригинал
 * или opus уже существующего трека, а при повторной загрузке того же файла
 * ничего лишнего не потеряется.
 */
async function runUploadPipeline(db: Knex, file: File): Promise<UploadResult> {
  const ext = extOf(file.name);
  const uploadPath = `${tmpDir()}/${crypto.randomUUID()}.upload`;
  const partPath = `${tmpDir()}/${crypto.randomUUID()}.opus.part`;

  try {
    // Сначала на диск, дальше весь пайплайн читает файл, а не память.
    await Bun.write(uploadPath, file);

    const uploaded = Bun.file(uploadPath);
    // BunFile.size ленивый: после rename пути уже нет и он вернул бы 0.
    const sizeBytes = uploaded.size;
    const id = await sha256File(uploaded);

    // Дешёвая проверка до всей работы: если файл не декодируется как аудио,
    // незачем ни спектр смотреть, ни гонять кодировщик.
    const input = await inspectInput(uploadPath);
    if (input.durationSec === null) {
      throw new InvalidAudioError("файл не читается как аудио");
    }

    // Теги и обложка читаются параллельно: это два независимых прохода
    // parseFile, но зато ни один не блокирует другой.
    const [fileTags, cover] = await Promise.all([
      readTags(uploadPath),
      extractCover(uploadPath),
    ]);
    const { tags, source: metaSource } = resolveTags(fileTags, file.name);

    // Разбор исходника идёт до конвертации: результат решает, какой битрейт
    // вообще имеет смысл. analyzeQuality не бросает исключений — при неудаче
    // просто вернётся 160k.
    const quality = await analyzeQuality(uploadPath);
    const ffmpegWarnings = await convertToOpus(uploadPath, partPath, quality.opusBitrate);

    // Сверяем, во что конвертация превратилась. Обрезанный MP3 даёт код 0 и
    // валидный Opus, поэтому единственный способ это заметить — сравнить
    // длительности.
    const conversion = await checkConversion(uploadPath, partPath, input);

    // Всё проверено — только теперь трогаем постоянное хранилище.
    const originalPath = `${originalDir()}/${id}.${ext}`;
    const opus = `${audioDir()}/${id}.opus`;
    await rename(uploadPath, originalPath);
    await rename(partPath, opus);

    // Обложка не обязательна: её битость или отсутствие — не повод отказывать
    // треку, звук уже проверен и лежит на месте.
    let coverPath: string | null = null;
    if (cover) {
      await mkdir(coverDir(), { recursive: true });
      coverPath = `${coverDir()}/${id}.${cover.ext}`;
      await Bun.write(coverPath, cover.data);
    }

    // Повторная загрузка того же файла не должна падать: onConflict игнорирует
    // дубль по первичному ключу, а нам важно лишь, что он был.
    const [insertedId] = await db("tracks")
      .insert({
        id,
        filename: file.name,
        ext,
        size_bytes: sizeBytes,
        opus_path: opus,
        cover_path: coverPath,
        bitrate_kbps: quality.bitrateKbps,
        vbr: quality.vbr,
        vbr_method: quality.vbrMethod,
        encoder: quality.encoder,
        duration_sec: quality.durationSec === null ? null : Math.round(quality.durationSec),
        cutoff_hz: quality.cutoffHz,
        opus_bitrate: quality.opusBitrate,
        // Теги раскладываются в ту же вставку, а не отдельным запросом:
        // трек без тегов — это тот же трек, просто с пустыми полями.
        ...toColumns(tags),
        // Отметка о происхождении: догадки из имени файла не должны
        // выглядеть в базе так же, как прочитанные теги.
        meta_source: metaSource,
      })
      .onConflict("id")
      .ignore()
      .returning("id");

    return {
      success: true,
      id,
      existed: insertedId === undefined,
      filename: file.name,
      audioUrl: `/audio/${id}`,
      coverUrl: coverPath ? `/cover/${id}` : null,
      quality: {
        sourceBitrateKbps: quality.bitrateKbps,
        vbr: quality.vbr,
        vbrMethod: quality.vbrMethod,
        encoder: quality.encoder,
        durationSec: quality.durationSec,
        cutoffHz: quality.cutoffHz,
        opusBitrate: quality.opusBitrate,
        reason: quality.reason,
      },
      tags,
      metaSource,
      // Звук декодируется целиком, но сам файл короче, чем обещает его
      // Xing/Info. Не повод отказывать, зато клиенту полезно знать.
      warnings: [
        ...ffmpegWarnings,
        ...(conversion.truncatedBySize
          ? [
              `файл короче заявленного: ${conversion.actualBytes} байт вместо ${conversion.declaredBytes}`,
            ]
          : []),
      ],
    };
  } finally {
    // К этому моменту rename уже унёс файлы, а после отказа остаётся мусор.
    await rm(uploadPath, { force: true });
    await rm(partPath, { force: true });
  }
}

/**
 * Тело PATCH. Поля необязательны: правится только то, что пришло.
 * Очистка поля — пустой строкой: отдельный null в API не заводим, схема
 * остаётся без Union (exact-mirror в этой версии Elysia ругается на него
 * при каждом запросе). Числа — числа, строки — строки.
 */
const patchSchema = t.Object({
  title: t.Optional(t.String()),
  artist: t.Optional(t.String()),
  album: t.Optional(t.String()),
  genre: t.Optional(t.String()),
  year: t.Optional(t.Integer()),
  trackNo: t.Optional(t.Integer()),
  trackTotal: t.Optional(t.Integer()),
  discNo: t.Optional(t.Integer()),
  discTotal: t.Optional(t.Integer()),
});

/**
 * Сборка приложения отдельно от прослушивания порта.
 *
 * db приходит параметром, а не импортом-синглтоном: так тесты могут
 * подставить временную базу и гонять хендлеры через app.handle(),
 * не трогая и даже не создавая storage/боевую БД.
 */
export function buildApp(db: Knex) {
  return new Elysia()
    .error("global", ({ error }) => {
      // Elysia приходит сюда с thrown-ошибками и уже выставила статус:
      // 404 для NotFound, 400 для ParseError, 422 для ValidationError,
      // 500 для остального. Статус не переопределяем, иначе потеряем
      // различие клиентских и серверных ошибок.
      // Клиент ждёт {"error": "..."} от любого провала, а не HTML страницу
      // или пустой ответ.
      return { error: error instanceof Error ? error.message : String(error) };
    })
    .get("/", () => status("OK"))
    .get(
      "/tracks",
      ({ query }) =>
        listTracks(db, {
          q: query.q ?? null,
          artist: query.artist ?? null,
          album: query.album ?? null,
          genre: query.genre ?? null,
          sort: query.sort ?? null,
          order: query.order ?? null,
          limit: query.limit ?? null,
          offset: query.offset ?? null,
        }),
    )
    .get("/tracks/:id", async ({ params }) => {
      const row = await db("tracks").where("id", params.id).first();
      if (!row) return errorResponse(404, "трек не найден");
      return trackToJson(row);
    })
    .patch(
      "/tracks/:id",
      { body: patchSchema },
      async ({ params, body }) => {
        const row = await db("tracks").where("id", params.id).first();
        if (!row) return errorResponse(404, "трек не найден");

        let columns: Record<string, string | number | null>;
        try {
          columns = patchToColumns(body as PatchBody);
        } catch (err) {
          const message = err instanceof RangeError ? "год вне диапазона 1000–3000" : String(err);
          return errorResponse(400, message);
        }
        if (Object.keys(columns).length === 0) return trackToJson(row);

        await db("tracks").where("id", params.id).update({ ...columns, meta_source: "edited" });
        const updated = await db("tracks").where("id", params.id).first();
        return trackToJson(updated!);
      },
    )
    .delete("/tracks/:id", async ({ params }) => {
      const row = await db("tracks").where("id", params.id).first();
      if (!row) return errorResponse(404, "трек не найден");

      // Сначала строка: после ответа клиенту трек не должен числиться в
      // библиотеке ни одним запросом, а с файлами, если что-то оборвалось
      // посреди rm, разберётся сканер storage/ (осиротевшие файлы — его
      // основная работа). В обратном порядке отказ unlink оставил бы трек,
      // указывающий в никуда.
      await db("tracks").where("id", params.id).del();

      const paths = [
        // Оригинал пути в БД не хранит — он собирается так же, как при записи.
        `${originalDir()}/${params.id}.${row.ext}`,
        row.opus_path,
        row.cover_path,
      ].filter((p): p is string => typeof p === "string");
      await Promise.all(paths.map((p) => rm(p, { force: true })));

      return { success: true, id: params.id };
    })
    .get("/audio/:id", ({ params, request }) => serveAudio(db, params.id, request, true))
    .head("/audio/:id", ({ params, request }) => serveAudio(db, params.id, request, false))
    .get("/cover/:id", ({ params }) => serveCover(db, params.id, true))
    .head("/cover/:id", ({ params }) => serveCover(db, params.id, false))
    .post(
      "/audio/upload",
      {
        body: t.Object({
          file: t.File({ format: "audio/*" }),
        }),
      },
      async ({ body: { file } }) => {
        try {
          return await runUploadPipeline(db, file);
        } catch (err) {
          // Мусор на входе — это вина клиента, а не сервера: 400 с внятным
          // текстом полезнее, чем 500 с простыней от ffmpeg.
          if (err instanceof InvalidAudioError) {
            return errorResponse(400, err.message);
          }
          throw err;
        }
      },
    );
}
