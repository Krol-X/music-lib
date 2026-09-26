import {Elysia, status, t} from "elysia";

const app = new Elysia()
  .get("/", () => status('OK'))
  .post('/audio/upload', {
    body: t.Object({
      file: t.File({format: "audio/*"}),
    })
  }, async ({body: {file}}) => {
    const buffer = Buffer.from(await file.arrayBuffer());
    await Bun.write(`./uploads/${file.name}`, buffer);
    return {success: true, name: file.name}
  })
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
