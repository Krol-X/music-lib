import {Elysia, status, t} from "elysia";

const uploadsDir = "./storage/uploads";
const convertDir = `./storage/converted`;

function safeName(name: string) {
  return name.split(/[\\/]/).pop()!.replace(/[^\w.\- ()]+/g, "_");
}

async function saveToOpus(source: ArrayBuffer, name: string) {
  const target = `${convertDir}/${safeName(name).replace(/\.[^.]+$/, "")}.opus`;
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-map_metadata", "0",
      "-c:a", "libopus",
      "-b:a", "128k",
      "-vbr", "on",
      "-compression_level", "10",
      "-f", "opus",
      "pipe:1",
    ],
    { stdin: new Blob([source]), stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`ffmpeg exited with ${code}: ${err.trim()}`);
  }
  await Bun.write(target, out);
  return target;
}

const app = new Elysia()
  .get("/", () => status('OK'))
  .post('/audio/upload', {
    body: t.Object({
      file: t.File({format: "audio/*"}),
    })
  }, async ({body: {file}}) => {
    const bytes = await file.arrayBuffer();
    await Bun.write(`${uploadsDir}/${safeName(file.name)}`, bytes);
    const opus = await saveToOpus(bytes, file.name);
    return {success: true, name: safeName(file.name), opus}
  })
  .listen(3000);

console.log(
  `* Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
