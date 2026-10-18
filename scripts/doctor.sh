#!/usr/bin/env bash
# Проверка, что на машине есть всё, что нужно MusicLib.
#
# Отдельно от mise тем, что mise ставит версии инструментов (bun), а здесь
# проверяются СИСТЕМНЫЕ вещи: ffmpeg нужен серверу, mpv — мосту, python3 и
# zenity — виджету. Их через mise не поставить, нужен пакетный менеджер.
set -uo pipefail

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

printf '\nMusicLib: проверка окружения\n\n'

# ── bun ──────────────────────────────────────────────────────────────────────
if command -v bun >/dev/null 2>&1; then
  ok "bun $(bun --version)"
else
  bad "bun не найден — поставь через mise: mise use -g bun@1.4.3"
fi

# ── ffmpeg ───────────────────────────────────────────────────────────────────
# Без него сервер не может ни конвертировать, ни измерить спектр: загрузка
# трека вернёт ошибку. Это единственная жёсткая зависимость сервера.
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
else
  bad "ffmpeg не найден — без него не работает загрузка треков
      Arch/Omarchy: sudo pacman -S ffmpeg
      Debian/Ubuntu: sudo apt install ffmpeg"
fi

# ── mpv ──────────────────────────────────────────────────────────────────────
# Играет сам мост. На omarchy он уже есть.
if command -v mpv >/dev/null 2>&1; then
  # Первая строка mpv --version начинается с "mpv 0.x", но в сборках omarchy
  # там "mpv  Copyright..." — берём первое слово вида 0.38.0, иначе подставим
  # всю строку, как раньше.
  ok "mpv $(mpv --version 2>/dev/null | head -1 | awk '{print ($2 ~ /^[0-9]/) ? $2 : "установлен"}')"
else
  warn "mpv не найден — сервер и API будут работать, но музыку не plays
      Arch/Omarchy: sudo pacman -S mpv"
  warn "  играть будет нечем, если только рядом нет другого MPRIS-плеера"
fi

# ── python3 ──────────────────────────────────────────────────────────────────
# Им заливается музыка из виджета (uploader.py). Требование к zip/lxml нет:
# стандартная библиотека.
if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"
else
  warn "python3 не найден — заливка из виджета работать не будет"
fi

# ── zenity ───────────────────────────────────────────────────────────────────
# Диалог выбора файлов при заливке.
if command -v zenity >/dev/null 2>&1; then
  ok "zenity"
else
  warn "zenity не найден — кнопка «залить» в виджете работать не будет"
fi

# ── оболочка ─────────────────────────────────────────────────────────────────
if command -v quickshell >/dev/null 2>&1; then
  ok "quickshell (виджет в баре доступен)"
else
  warn "quickshell не найден — виджет в баре не появится.
      Сервер при этом работает: библиотекой можно пользоваться по HTTP."
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf 'Всё необходимое на месте. Дальше: mise run install\n\n'
else
  printf 'Не хватает обязательного — поставь и прогони doctor ещё раз.\n\n'
fi
exit "$fail"