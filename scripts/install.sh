#!/usr/bin/env bash
# Установка MusicLib на машину с omarchy.
#
# Делает три вещи и ничего не ломает при повторном запуске:
#   1. ставит systemd-юниты пользователя, подставив в них путь к этому checkout'у;
#   2. кладёт плагин в оболочку СИМЛИНКОМ на репозиторий, а не копией —
#      копия разъезжается с исходниками, и правки виджета молча не доезжают;
#   3. выполняет bun install.
#
# sudo не нужен: всё ставится в ~/.config.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
units_dir="$HOME/.config/systemd/user"
plugins_dir="$HOME/.config/omarchy/plugins"
plugin_id="krol.media"
plugin_target="$root/desktop-plugin/$plugin_id"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }

# ── 1. зависимости ───────────────────────────────────────────────────────────
say "Зависимости проекта"
bun install --frozen-lockfile
ok "bun install"

# ── 2. systemd-юниты ──────────────────────────────────────────────────────────
# Путь к проекту неизвестен заранее (checkout может лежать где угодно), поэтому
# в шаблонах вместо него плейсхолдер __MUSICLIB_DIR__, а сюда подставляется
# фактический путь. Так одни и те же шаблоны годятся и в ~/Work, и в
# ~/.local/share.
say "systemd-юниты"
mkdir -p "$units_dir"
# Путь к bun узнаём у mise, а не берём из ~/.bun/bin: с mise он может быть
# любым (shims, кэш версий), и зашитый путь однажды просто перестанет работать.
bun_bin="$(command -v bun || true)"
if [ -z "$bun_bin" ]; then
  bad "bun не найден в PATH — поставь через mise и повтори"
  exit 1
fi
for tpl in "$root"/systemd/*.service.in; do
  [ -e "$tpl" ] || { warn "шаблонов не найдено"; continue; }
  name="$(basename "$tpl" .in)"
  escaped_root="$(printf '%s' "$root" | sed 's/[\/&|]/\\&/g')"
  sed -e "s|__MUSICLIB_DIR__|$escaped_root|g" \
      -e "s|__BUN_BIN__|$bun_bin|g" "$tpl" > "$units_dir/$name"
  ok "$units_dir/$name"
done
systemctl --user daemon-reload
ok "daemon-reload"

# ── 3. плагин оболочки ───────────────────────────────────────────────────────
# Оболочка читает плагины из ~/.config/omarchy/plugins, а репозиторий лежит
# отдельно. Симлинк — единственный способ, при котором правка в исходниках
# видна в виджете сразу, без ручного копирования.
say "Плагин оболочки ($plugin_id)"
if [ ! -d "$plugin_target" ]; then
  bad "не найден каталог плагина: $plugin_target"
  exit 1
fi

if command -v omarchy >/dev/null 2>&1; then
  mkdir -p "$plugins_dir"
  existing="$plugins_dir/$plugin_id"
  if [ -L "$existing" ]; then
    if [ "$(readlink -f "$existing")" = "$(readlink -f "$plugin_target")" ]; then
      ok "уже ссылается на репозиторий"
    else
      ln -sfn "$plugin_target" "$existing"
      ok "переключена ссылка на репозиторий"
    fi
  elif [ -d "$existing" ]; then
    # Копия от предыдущей установки: сохраняем и заменяем ссылкой, иначе правки
    # в репозитории так и не доедут до виджета.
    #
    # Бэкап уводим ЗА пределы ~/.config/omarchy/plugins: оболочка перебирает
    # этот каталог целиком и зарегистрировала бы копию как ещё один плагин с
    # тем же id — виджет грузился бы из бэкапа, а не из репозитория.
    backups_dir="$HOME/.local/state/music-lib/plugin-backups"
    mkdir -p "$backups_dir"
    backup="$backups_dir/$plugin_id-$(date +%Y%m%d-%H%M%S)"
    mv "$existing" "$backup"
    ln -sfn "$plugin_target" "$existing"
    ok "копия сохранена в $backup, вместо неё — ссылка на репозиторий"
  else
    ln -sfn "$plugin_target" "$existing"
    ok "установлен"
  fi
  printf '     виджет подхватит изменения после перезагрузки оболочки:\n'
  printf '     qs -p /usr/share/omarchy/shell ipc call shell rescanPlugins\n'
else
  warn "omarchy не найден — плагин пропущен."
  warn "  Его всё равно можно поставить вручную:"
  warn "  mkdir -p ~/.config/omarchy/plugins && ln -s $plugin_target ~/.config/omarchy/plugins/$plugin_id"
fi

say "Готово"
printf '  Запустить:   mise run start\n'
printf '  Состояние:   mise run status\n'
printf '  Логи:        mise run logs\n\n'