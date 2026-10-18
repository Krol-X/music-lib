#!/usr/bin/env bash
# Снятие MusicLib: останавливает и отключает юниты, убирает плагин.
# Файлы библиотеки (storage/, база, opus) НЕ трогает — это данные, а не установка.
#
# Если плагин был поставлен копией, а не ссылкой, она лежит рядом как
# *.backup-<дата>; её удалять или нет — решает человек.
set -uo pipefail

plugin_id="krol.media"
plugins_dir="$HOME/.config/omarchy/plugins"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }

say "Остановка"
if systemctl --user disable --now music-lib.service music-lib-player.service 2>/dev/null; then
  ok "юниты остановлены и отключены"
else
  warn "юниты не запущены (или их нет)"
fi

say "Файлы юнитов"
for f in music-lib.service music-lib-player.service; do
  p="$HOME/.config/systemd/user/$f"
  if [ -e "$p" ]; then rm -f "$p" && ok "удалён $f"; fi
done
systemctl --user daemon-reload && ok "daemon-reload"

say "Плагин"
existing="$plugins_dir/$plugin_id"
if [ -L "$existing" ]; then
  rm "$existing"
  ok "ссылка удалена (исходники в репозитории не тронуты)"
elif [ -d "$existing" ]; then
  warn "это копия, не ссылка — оставил на месте. Удалить руками:"
  warn "  rm -rf $existing"
fi

# Копии, отложенные install'ом, лежат вне каталога плагинов (иначе оболочка
# зарегистрировала бы их как ещё один плагин с тем же id). Их не удаляем:
# это данные, а не установка.
backups="$HOME/.local/state/music-lib/plugin-backups"
if [ -d "$backups" ] && [ -n "$(ls -A "$backups" 2>/dev/null)" ]; then
  warn "отложенные копии плагина остались здесь:"
  warn "  $backups"
fi

say "Готово"
printf '  Данные библиотеки (storage/, база, opus) остались на месте.\n'
printf '  Удалить их — rm -rf storage\n\n'