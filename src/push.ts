/**
 * Push-канал виджету: unix-сокет в XDG_RUNTIME_DIR (приватный на юзера,
 * автоматически чистится при загрузке). TCP не берём — Socket у Quickshell
 * умеет только path, и не мудрим с SSE: строка JSON за переносом строки,
 * SplitParser на клиенте разбирает её сам.
 *
 * События:
 *  - «played»: факт порога у моста, штамп на сервере, виджет поднимает
 *    трек в «недавно прослушанные» по-живому.
 *  - «convert»: прогресс конвертации трека (имя + процент 0..100%).
 */
import { unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const pushSocketPath =
  process.env.MUSICLIB_PUSH ??
  `${process.env.XDG_RUNTIME_DIR ?? "/run/user/1000"}/music-lib-push.sock`;

interface Client {
  write: (line: string) => void;
}

const clients = new Set<Client>();
let pushServer: ReturnType<typeof Bun.listen> | null = null;

/**
 * Запуск сервера push-канала.
 * Безопасен при повторном вызове, создаёт родительский каталог и чистит
 * старый файл сокета.
 */
export function startPushServer(path: string = pushSocketPath) {
  if (pushServer) return pushServer;
  if (!path || path === "none" || path === "disabled") return null;

  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      unlinkSync(path);
    } catch {
      // Старого сокета не было — норм
    }

    pushServer = Bun.listen({
      unix: path,
      socket: {
        open: (sock) => {
          clients.add(sock as unknown as Client);
        },
        close: (sock) => {
          clients.delete(sock as unknown as Client);
        },
        error: (sock) => {
          clients.delete(sock as unknown as Client);
        },
        data: () => {
          // Виджет ничего не шлёт в этот сокет
        },
      },
    });
    return pushServer;
  } catch (err) {
    // В тестовом окружении или без прав на каталог сокета не роняем процесс
    console.warn(`* push-сокет недоступен (${path}):`, (err as Error).message);
    return null;
  }
}

/** Остановка сокета и удаление файла. */
export function stopPushServer() {
  if (pushServer) {
    try {
      pushServer.stop(true);
    } catch {
      // Игнорируем
    }
    pushServer = null;
  }
  try {
    unlinkSync(pushSocketPath);
  } catch {
    // Игнорируем
  }
}

// Автозапуск только вне тестов; в тестах сокет не нужен, чтобы не мусорить в файловой системе.
const isTestEnv =
  process.env.NODE_ENV === "test" ||
  Boolean(process.env.BUN_TEST) ||
  process.argv.some((arg) => arg.includes("test"));

if (!isTestEnv) {
  startPushServer();
}

/** Совместимость с экспортом push */
export const push = pushServer;

/** Общая рассылка строки; dead-клиенты молча отрезаем. */
function broadcastLine(line: string): void {
  for (const sock of clients) {
    try {
      sock.write(line);
    } catch {
      clients.delete(sock);
    }
  }
}

/** Прогресс конвертации наружу: у виджета строки c NN%. */
export function broadcastConvert(payload: { name: string; pct: number }): void {
  broadcastLine(JSON.stringify({ event: "convert", ...payload }) + "\n");
}

export function broadcastPlayed(payload: {
  trackId: string;
  lastPlayed: string;
  playCount: number;
}): void {
  broadcastLine(JSON.stringify({ event: "played", ...payload }) + "\n");
}
