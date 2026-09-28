import { mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Elysia, status, t } from "elysia";
import { db } from "./db";
import { analyzeQuality } from "./audio/quality";
import { parseRange } from "./audio/range";
import {
  InvalidAudioError,
  checkConversion,
  inspectInput,
} from "./audio/validate";

const storageDir = "./storage";
/** Как файл пришёл: для перекодирования в другой битрейт и для обложек. */
const originalDir = `${storageDir}/original`;
/** Что мы отдаём на прослушивание. */
const audioDir = `${storageDir}/audio`;
/** Обложки, появятся позже. */
const coverDir = `${storageDir}/cover`;
/** Промежуточное: сюда ffmpeg пишет .part, отсюда rename в audio/. */
const tmpDir = `${storageDir}/tmp`;

async function ensureDirs() {
  for (const dir of [originalDir, audioDir, coverDir, tmpDir]) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * tmp/ — единственное место, где могут валяться огрызки. Стираем на старте:
 * если процесс упал посреди конвертации, .part-файлы уже никому не нужны.
 */
async function sweepTmp() {
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
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
 */
async function convertToOpus(
  sourcePath: string,
  outputPath: string,
  bitrate: string,
): Promise<void> {
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
}

// Папки готовятся до listen, чтобы первый же запрос не упал на mkdir.
await sweepTmp();
await ensureDirs();

/**
 * Отдаёт файл трека, понимая заголовок Range.
 *
 * Путь к файлу берётся из БД, а не собирается из id, поэтому подставить
 * ../../etc/passwd через параметр нельзя: id используется только как ключ
 * выборки, и несуществующий просто даёт 404.
 */
async function serveAudio(id: string, request: Request, withBody: boolean): Promise<Response> {
  const json = (code: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status: code,
      headers: { "Content-Type": "application/json" },
    });

  const track = await db("tracks").where("id", id).first();
  if (!track) return json(404, "трек не найден");

  const file = Bun.file(track.opus_path as string);
  if (!(await file.exists())) return json(404, "файл аудио отсутствует на диске");

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

/** Ответ загрузки: ровно то, что видит клиент. */
interface UploadResult {
  success: true;
  id: string;
  existed: boolean;
  filename: string;
  opus: string;
  quality: unknown;
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
async function runUploadPipeline(file: File): Promise<UploadResult> {
  const ext = extOf(file.name);
  const uploadPath = `${tmpDir}/${crypto.randomUUID()}.upload`;
  const partPath = `${tmpDir}/${crypto.randomUUID()}.opus.part`;

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

    // Разбор исходника идёт до конвертации: результат решает, какой битрейт
    // вообще имеет смысл. analyzeQuality не бросает исключений — при неудаче
    // просто вернётся 160k.
    const quality = await analyzeQuality(uploadPath);
    await convertToOpus(uploadPath, partPath, quality.opusBitrate);

    // Сверяем, во что конвертация превратилась. Обрезанный MP3 даёт код 0 и
    // валидный Opus, поэтому единственный способ это заметить — сравнить
    // длительности.
    const conversion = await checkConversion(uploadPath, partPath, input);

    // Всё проверено — только теперь трогаем постоянное хранилище.
    const originalPath = `${originalDir}/${id}.${ext}`;
    const opus = `${audioDir}/${id}.opus`;
    await rename(uploadPath, originalPath);
    await rename(partPath, opus);

    // Повторная загрузка того же файла не должна падать: onConflict игнорирует
    // дубль по первичному ключу, а нам важно лишь, что он был.
    const [insertedId] = await db("tracks")
      .insert({
        id,
        filename: file.name,
        ext,
        size_bytes: sizeBytes,
        opus_path: opus,
        bitrate_kbps: quality.bitrateKbps,
        vbr: quality.vbr,
        vbr_method: quality.vbrMethod,
        encoder: quality.encoder,
        duration_sec: quality.durationSec === null ? null : Math.round(quality.durationSec),
        cutoff_hz: quality.cutoffHz,
        opus_bitrate: quality.opusBitrate,
      })
      .onConflict("id")
      .ignore()
      .returning("id");

    return {
      success: true,
      id,
      existed: insertedId === undefined,
      filename: file.name,
      opus,
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
      // Звук декодируется целиком, но сам файл короче, чем обещает его
      // Xing/Info. Не повод отказывать, зато клиенту полезно знать.
      warnings: conversion.truncatedBySize
        ? [
            `файл короче заявленного: ${conversion.actualBytes} байт вместо ${conversion.declaredBytes}`,
          ]
        : [],
    };
  } finally {
    // К этому моменту rename уже унёс файлы, а после отказа остаётся мусор.
    await rm(uploadPath, { force: true });
    await rm(partPath, { force: true });
  }
}

const app = new Elysia()
  .get("/", () => status("OK"))
  .get("/audio/:id", ({ params, request }) => serveAudio(params.id, request, true))
  .head("/audio/:id", ({ params, request }) => serveAudio(params.id, request, false))
  .post(
    "/audio/upload",
    {
      body: t.Object({
        file: t.File({ format: "audio/*" }),
      }),
    },
    async ({ body: { file } }) => {
      try {
        return await runUploadPipeline(file);
      } catch (err) {
        // Мусор на входе — это вина клиента, а не сервера: 400 с внятным
        // текстом полезнее, чем 500 с простыней от ffmpeg.
        if (err instanceof InvalidAudioError) {
          return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw err;
      }
    },
  )
  .listen(3000);

console.log(`* Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

process.on("SIGINT", async () => {
  await db.destroy();
  process.exit(0);
});
