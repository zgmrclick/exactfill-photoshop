#!/bin/bash
# Встановлює/оновлює плагін у Photoshop.
#
# Пароль потрібен ЛИШЕ на перше встановлення: /Applications/.../Plug-ins
# належить root, тому створити там папку без sudo не можна. Далі скрипт робить
# chown на вас, і всі наступні оновлення йдуть без пароля — тому спершу
# пробуємо без sudo і звертаємось до нього тільки якщо запис не вдався.
set -e

# ⚠️ Назва папки мусить збігатися з тією, що вже стоїть у Photoshop. Тут довго
# лишалось AiImagePS із часів, коли плагін так і звався: після перейменування
# на ExactFill цей скрипт створював би ДРУГУ папку з тим самим manifest id
# поруч із робочою, замість оновити її. Гейт — тест «deploy target matches
# the installed plugin folder».
DEST="/Applications/Adobe Photoshop 2026/Plug-ins/ExactFill"
SRC="$(cd "$(dirname "$0")" && pwd)"
EXCL=(--include 'icons/exactfill.svg' --include 'icons/panel-*.png' --exclude 'icons/*'
      --exclude '.git' --exclude 'test' --exclude 'CONTRACTS.md'
      --exclude 'deploy.sh' --exclude 'INSTALL.txt'
      --exclude 'README.md' --exclude 'README.uk.md' --exclude 'LICENSE'
      --exclude 'PRIVACY.md' --exclude 'SUPPORT.md' --exclude 'SECURITY.md'
      --exclude 'CONTRIBUTING.md' --exclude 'CHANGELOG.md'
      --exclude 'package.json' --exclude '.gitignore' --exclude '.github'
      --exclude 'scripts' --exclude 'dist' --exclude 'node_modules' --exclude 'docs'
      --exclude 'verify' --exclude 'verify-assumptions.psjs' --exclude '.DS_Store')

if [ -d "$DEST" ] && [ -w "$DEST" ]; then
    rsync -a --delete --delete-excluded "${EXCL[@]}" "$SRC/" "$DEST/"
    echo "✓ Оновлено без пароля: $DEST"
else
    echo "Перше встановлення — потрібен пароль (Plug-ins належить root)."
    sudo rsync -a --delete --delete-excluded "${EXCL[@]}" "$SRC/" "$DEST/"
    sudo chown -R "$(id -un):staff" "$DEST"
    echo "✓ Встановлено: $DEST"
    echo "  Наступні оновлення пароля вже не потребують."
fi

echo "  Перезапустіть Photoshop → Plugins → ExactFill"
