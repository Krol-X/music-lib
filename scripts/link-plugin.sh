#!/usr/bin/env bash
# Ставит плагин оболочки ссылкой на репозиторий.
#
# Отдельной командой потому, что это единственное, что стоит повторять часто:
# после смены режима сортировки или правки виджета не нужно ни reinstall, ни
# перезапуск сервисов — достаточно перезагрузить оболочку.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_id="krol.media"
plugins_dir="$HOME/.config/omarchy/plugins"
target="$root/desktop-plugin/$plugin_id"

[ -d "$target" ] || { printf 'не найден каталог плагина: %s\n' "$target"; exit 1; }

mkdir -p "$plugins_dir"
ln -sfn "$target" "$plugins_dir/$plugin_id"
printf 'плагин → %s\n' "$target"

# Оболочка держит уже загруженный QML и не подхватывает файл сама: без
# сброса кэша она продолжит исполнять старую версию, и правка будет выглядеть
# как «ничего не изменилось».
if command -v qs >/dev/null 2>&1; then
  printf '\nперезагружаю оболочку…\n'
  rm -rf "$HOME/.cache/quickshell/qmlcache" 2>/dev/null || true
  qs -p /usr/share/omarchy/shell ipc call shell rescanPlugins >/dev/null 2>&1 \
    && printf 'ok, плагин перезагружен\n' \
    || printf 'не смог достучаться до оболочки — перезагрузи её вручную\n'
else
  printf '\nqs не найден — оболочку перезагрузи вручную.\n'
fi