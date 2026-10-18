import { db } from "./db";
import { buildApp, ensureDirs, sweepTmp } from "./app";
import { startPushServer, stopPushServer } from "./push";

const HOST = process.env.MUSICLIB_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.MUSICLIB_PORT ?? "3000", 10);

const app = buildApp(db);

function shutdown(signal: string) {
  void (async () => {
    console.log(`* ${signal}: закрываюсь`);
    try {
      app.stop(true);
    } catch {
      // Может не остановиться, если сервер ещё не начал слушать.
    }
    try {
      // Push-канал: мёртвый сокет не нужен следующему запуску — имя должно
      // быть свободно к рестарту юнита.
      stopPushServer();
    } catch {
      // Не было — норм.
    }
    await db.destroy();
    process.exit(0);
  })();
}

if (import.meta.main) {
  // Папки и миграции готовятся до listen, чтобы первый же запрос не упал
  // ни на mkdir, ни на отсутствующую таблицу.
  await sweepTmp();
  await ensureDirs();
  const [, applied] = await db.migrate.latest();
  if (applied.length > 0) console.log(`* миграции: ${applied.join(", ")}`);

  startPushServer();
  app.listen({ hostname: HOST, port: PORT });

  console.log(`* Elysia is running at http://${HOST}:${PORT}`);

  // Выход только через db.destroy(): закрытый reply не оставит висящих
  // соединений. SIGTERM отдельно, потому что systemd и docker останавливают
  // сервис именно им, а не SIGINT.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
