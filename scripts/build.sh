#!/usr/bin/env bash
# Прод-сборка: один исполняемый файл со встроенным bun.
#
# Нужна там, где bun и node_modules ставить некуда или не хочется: NAS,
# контейнер, чужая машина. Бинарник переносится сам по себе — но ffmpeg
# ему всё равно нужен системный, он зовётся subprocess'ом.
#
# Что внутри: сервер (src/index.ts). Мост (player/bridge.mjs) собирается
# отдельно и по-другому — он ходит в mpv и dbus, см. README.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
outdir="$root/dist"
outfile="$outdir/music-lib"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }

# bad() без exit: shellcheck считает код после вызова bad() недостижимым и
# ругается (SC2317), а выход всё равно делает вызывающий код через return.
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; return 1; }

if ! command -v bun >/dev/null 2>&1; then
  bad "bun не найден — поставь через mise" || exit 1
fi

say "Сборка"
mkdir -p "$outdir"

# ── точка входа для бинарника ────────────────────────────────────────────────
# В бинарнике рядом нет ни файлов миграций, ни каталога src: import.meta.dir
# указывает внутрь образа. Поэтому точку входа генерируем — она импортирует
# миграции как обычные модули (bundler встроит их) и отдаёт их knex через
# migrationSource вместо чтения каталога.
#
# Файл кладём во временный каталог ВНЕ проекта: tsconfig без include проверяет
# все .ts подряд, и сгенерированная точка входа роняла бы `bun run typecheck`
# в чистом клоне.
work="$(mktemp -d)"
entry="$work/entry.ts"

{
  printf '// Сгенерировано scripts/build.sh — руками не править.\n'
  printf 'import "%s/src/typebox-setup";\n' "$root"
  printf 'import { createDb } from "%s/src/db/index";\n' "$root"
  printf 'import { startServer } from "%s/src/index";\n\n' "$root"
  printf 'const migrations: Record<string, unknown> = {};\n'

  i=0
  for f in "$root"/src/db/migrations/*.ts; do
    [ -e "$f" ] || continue
    i=$((i + 1))
    printf 'import * as m%d from "%s";\n' "$i" "$f"
    printf 'migrations["%s"] = m%d;\n' "$(basename "$f")" "$i"
  done

  [ "$i" -gt 0 ] || { bad "миграции не найдены в src/db/migrations" || exit 1; }

  cat <<'TS'

const migrationSource = {
  async getMigrations() {
    return Object.keys(migrations).map((file) => ({ file, directory: "" }));
  },
  getMigrationName(m: { file: string }) {
    return m.file;
  },
  getMigration(info: { file: string }) {
    return migrations[info.file];
  },
};

const db = await createDb({ migrations: { migrationSource } as never });
await startServer(db);
TS
} > "$entry"

ok "точка входа с ${i} миграциями"

# knex тянет require() ВСЕХ диалектов (mssql, oracle, postgres, mariadb…),
# даже используемый нам sqlite. Не установленные optional-зависимости
# бандлер не может разрешить и падает, поэтому они помечаются внешними:
# в рантайме сервер до них не доходит, ему нужен только свой диалект.
if ! bun build --compile \
  --outfile "$outfile" \
  --external tedious \
  --external oracledb \
  --external pg \
  --external mysql \
  --external mysql2 \
  --external mariadb \
  --external mariadb/callback \
  --external cockroachdb \
  --external redshift \
  --external sqlite3 \
  --external better-sqlite3 \
  --external sqlite \
  "$entry"; then
  bad "сборка не удалась" || exit 1
fi
rm -rf "$work"

[ -f "$outfile" ] || bad "сборка не дала файл"
ok "$outfile ($(du -h "$outfile" | cut -f1))"

say "Проверка"
# Поднимаем на отдельном порту и с отдельной базой, чтобы не задеть боевой
# сервер: бинарник, который не стартует, бесполезен и обнаруживается только
# на чужой машине.
port="${MUSICLIB_TEST_PORT:-3999}"
tmpdir="$(mktemp -d)"
log="$tmpdir/server.log"
MUSICLIB_PORT="$port" \
MUSICLIB_STORAGE="$tmpdir/storage" \
MUSICLIB_DB="$tmpdir/test.sqlite" \
MUSICLIB_PUSH=none \
  "$outfile" > "$log" 2>&1 &
pid=$!

ok_code=1
for _ in $(seq 1 25); do
  if curl -fsS -m 2 "http://127.0.0.1:$port/" >/dev/null 2>&1; then ok_code=0; break; fi
  sleep 0.4
done

cleanup() { kill "$pid" 2>/dev/null || true; rm -rf "$tmpdir"; }
trap cleanup EXIT

if [ "$ok_code" -ne 0 ]; then
  bad "бинарник не отвечает на порту $port. Журнал:"
  tail -20 "$log"
  exit 1
fi
ok "отвечает на /"
count="$(curl -fsS -m 3 "http://127.0.0.1:$port/tracks?limit=1" | grep -o '"total":[0-9]*' | head -1 || true)"
ok "отвечает на /tracks ${count:-(ответ получен)}"

say "Готово"
printf '  Бинарник: %s\n' "$outfile"
printf '  На другой машине нужен только ffmpeg:\n'
printf '    MUSICLIB_STORAGE=/path/to/storage ./music-lib\n\n'
printf '  sharp в бинарник не встроен (нативный модуль): обложки отдаются\n'
printf '  оригиналом, превью ?w= не делается. Всё остальное работает.\n\n'