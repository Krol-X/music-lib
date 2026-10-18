/**
 * Push-канал виджету: unix-сокет в XDG_RUNTIME_DIR (приватный на юзера,
 * автоматически чистится при загрузке). TCP не берём — Socket у Quickshell
 * умеет только path, и не мудрим с SSE: строка JSON за переносом строки,
 * SplitParser на клиенте разбирает её сам.
 *
 * Пока событие одно — «played»: факт порога у моста, штамп на сервере,
 * виджет поднимает трек в «недавно прослушанные» по-живому. Виджету не
 * пересылаем список напрямую — он сам решает, что и когда перезагрузить.
 */
import { unlinkSync } from "node:fs";

export const pushSocketPath =
  process.env.MUSICLIB_PUSH ??
  `${process.env.XDG_RUNTIME_DIR ?? "/run/user/1000"}/music-lib-push.sock`;

// Остатки прошлой жизни: только до listen, иначе снесём наш же свежий сокет.
try {
  unlinkSync(pushSocketPath);
} catch {
  // Не было — и хорошо.
}

interface Client {
  write: (line: string) => void;
}

const clients = new Set<Client>();

export const push = Bun.listen({
  unix: pushSocketPath,
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
      // События идут только от сервера к виджетам; виджет ничего не говорит.
    },
  },
});

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
