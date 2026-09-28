/**
 * Путь к загружаемому расширению sqlite-vec.
 *
 * Раньше путь задавался переменной окружения и жил в /tmp, из-за чего тест
 * молча пропускался: переменную никто не ставил, и провал выглядел как «тестов
 * нет». Теперь бинарь приезжает пакетом `sqlite-vec` вместе с зависимостями, а
 * платформенный модуль лежит рядом в node_modules — резолвить путь достаточно.
 *
 * Переменная окружения оставлена как переопределение: на нестандартной сборке
 * или при сборке расширения из исходников путь будет другим.
 */

import { createRequire } from "node:module";

const OVERRIDE_ENV = "SQLITE_VEC_PATH";

let cached: { path: string | null } | null = null;

/**
 * Возвращает путь к vec0 либо null, если расширение для этой платформы не
 * установлено. null — не ошибка: без него не работает только векторный поиск.
 */
export function sqliteVecPath(): string | null {
  if (cached) return cached.path;

  const override = process.env[OVERRIDE_ENV];
  if (override) {
    cached = { path: override };
    return override;
  }

  // Пакет умеет сам находить нужный под платформу бинарь и бросает, если
  // платформа не поддерживается. Обнулённый require.cache нужен, чтобы
  // повторные вызовы в том же процессе не кэшировали неудачу.
  try {
    const req = createRequire(import.meta.url);
    delete req.cache[req.resolve("sqlite-vec")];
    const { getLoadablePath } = req("sqlite-vec") as { getLoadablePath(): string };
    const path = getLoadablePath();
    cached = { path: Bun.file(path).size > 0 ? path : null };
  } catch {
    cached = { path: null };
  }

  return cached.path;
}

export { OVERRIDE_ENV as SQLITE_VEC_PATH_ENV };
