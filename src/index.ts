// ПЕРВЫМ, до app: схемы строятся в теле app.ts, и TypeBox к этому моменту
// должен быть уже подключён явно. Подробности в src/typebox-setup.ts.
import "./typebox-setup";
import type { Knex } from "knex";
import { buildApp, ensureDirs, sweepTmp } from "./app";
import { startPushServer, stopPushServer } from "./push";

const HOST = process.env.MUSICLIB_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.MUSICLIB_PORT ?? "3000", 10);

/**
 * Поднимает сервер.
 *
 * Базу можно передать: прод-сборка (bun build --compile) встраивает миграции
 * в бинарник, потому что файлов миграций рядом с ним нет, и обычный путь
 * «прочитать каталог» там не работает. Без аргумента берётся обычная база из
 * ./db, и всё как раньше.
 */
export async function startServer(dbArg?: Knex): Promise<void> {
  // Импорт динамический: при импорте этого модуля (из точки входа бинарника)
  // создавать соединение с БД не нужно и нельзя — путь к миграциям там
  // невалиден, и провиснет всё подряд.
  const db = dbArg ?? (await import("./db")).db;

  const app = buildApp(db);

  const shutdown = (signal: string) => {
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
  };

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

if (import.meta.main) {
  await startServer();
}