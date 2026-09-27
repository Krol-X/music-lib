import { mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Elysia, status, t } from "elysia";
import { db } from "./db";

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
 */
async function convertToOpus(sourcePath: string, id: string): Promise<string> {
  const partPath = `${tmpDir}/${id}.opus.part`;
  const target = `${audioDir}/${id}.opus`;

  // ffmpeg открывает stdout на append, поэтому старый .part надо убрать,
  // иначе повторная конвертация допишет в конец.
  await rm(partPath, { force: true });

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel", "error",
      "-i", sourcePath,
      "-map_metadata", "0",
      "-c:a", "libopus",
      "-b:a", "128k",
      "-vbr", "on",
      "-compression_level", "10",
      "-f", "opus",
      "pipe:1",
    ],
    { stdout: Bun.file(partPath), stderr: "pipe" },
  );

  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;

  if (code !== 0) {
    await rm(partPath, { force: true });
    throw new Error(`ffmpeg exited with ${code}: ${err.trim()}`);
  }

  await rename(partPath, target);
  return target;
}

// Папки готовятся до listen, чтобы первый же запрос не упал на mkdir.
await sweepTmp();
await ensureDirs();

const app = new Elysia()
  .get("/", () => status("OK"))
  .post(
    "/audio/upload",
    {
      body: t.Object({
        file: t.File({ format: "audio/*" }),
      }),
    },
    async ({ body: { file } }) => {
      const ext = extOf(file.name);
      const uploadPath = `${tmpDir}/${crypto.randomUUID()}.upload`;

      try {
        // Сначала на диск, дальше весь пайплайн читает файл, а не память.
        await Bun.write(uploadPath, file);

        const uploaded = Bun.file(uploadPath);
        // BunFile.size ленивый: после rename пути уже нет и он вернул бы 0.
        const sizeBytes = uploaded.size;
        const id = await sha256File(uploaded);
        const originalPath = `${originalDir}/${id}.${ext}`;

        // rename, а не копирование: temp нам уже не нужен.
        await rename(uploadPath, originalPath);
        const opus = await convertToOpus(originalPath, id);

        // Повторная загрузка того же файла не должна падать: onConflict игнорирует
        // дубль по первичному ключу, а нам важно лишь, что он был.
        const [insertedId] = await db("tracks")
          .insert({
            id,
            filename: file.name,
            ext,
            size_bytes: sizeBytes,
            opus_path: opus,
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
        };
      } finally {
        await rm(uploadPath, { force: true });
      }
    },
  )
  .listen(3000);

console.log(`* Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

process.on("SIGINT", async () => {
  await db.destroy();
  process.exit(0);
});
