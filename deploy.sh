#!/bin/bash
# Встановлює плагін у Photoshop. Потребує пароля: Plug-ins належить root.
set -e
DEST="/Applications/Adobe Photoshop 2026/Plug-ins/AiImagePS"
SRC="$(cd "$(dirname "$0")" && pwd)"
sudo rsync -a --delete \
  --exclude '.git' --exclude 'test' --exclude 'CONTRACTS.md' \
  --exclude 'deploy.sh' --exclude '.gitignore' \
  "$SRC/" "$DEST/"
sudo chown -R "$(id -un):staff" "$DEST"
echo "✓ Встановлено: $DEST"
echo "  Перезапустіть Photoshop → Plugins → AI Image"
