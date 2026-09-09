#!/usr/bin/env bash
# Чи існує gpt-image-2.5 на живому API і чи приймає він нашу форму запиту.
#
# Ключ береться з оточення і НІКУДИ не пишеться. Запуск:
#   OPENAI_API_KEY='sk-...' ./verify/check-models.sh
#   OPENAI_API_KEY='sk-...' ./verify/check-models.sh --paid   # + один платний запит
#
# Без --paid скрипт нічого не витрачає: і каталог, і проба доступності безкоштовні.
set -uo pipefail

: "${OPENAI_API_KEY:?поставте OPENAI_API_KEY у середовищі}"
CFG="$(mktemp)"; trap 'rm -f "$CFG"' EXIT
printf 'header = "Authorization: Bearer %s"\nsilent\nshow-error\n' "$OPENAI_API_KEY" > "$CFG"
HERE="$(dirname "$0")"

echo "=== 1. Що ключ бачить у каталозі /v1/models ==="
curl --config "$CFG" https://api.openai.com/v1/models \
  | python3 "$HERE/check-models.py" models || exit 1

# ⚠️ Каталог — не право доступу. Крок 1 показує лише те, що OpenAI вирішив
# перелічити; судити з нього про доступність моделі — помилка, яка коштувала
# нам хибного висновку 2026-09-09. Тому питаємо той самий ендпоінт, яким
# користується плагін.
echo
echo "=== 2. Чи приймає ендпоінт генерації саму модель (безкоштовно) ==="
echo "    Запит навмисно невалідний, тож нічого не генерує. Читаємо причину відмови."
echo
echo "    контролі — без них відповіді нижче нічого не варті:"
for M in gpt-image-2 zzz-model-that-cannot-exist; do
    printf '      %-30s ' "$M"
    curl --config "$CFG" -H 'Content-Type: application/json' -w '\n%{http_code}' \
        -d "{\"model\":\"$M\",\"prompt\":\"x\",\"size\":\"1x1\"}" \
        https://api.openai.com/v1/images/generations \
        | python3 "$HERE/check-models.py" probe || exit 1
done
echo
echo "    те, заради чого все:"
for M in gpt-image-2.5-sunburst gpt-image-2.5-flare; do
    printf '      %-30s ' "$M"
    curl --config "$CFG" -H 'Content-Type: application/json' -w '\n%{http_code}' \
        -d "{\"model\":\"$M\",\"prompt\":\"x\",\"size\":\"1x1\"}" \
        https://api.openai.com/v1/images/generations \
        | python3 "$HERE/check-models.py" probe || exit 1
done

echo
echo "  Як читати: якщо контроль gpt-image-2 = ДОСТУПНА, а неіснуюча модель ="
echo "  НЕМА ДОСТУПУ — проба розрізняє, і рядкам нижче можна вірити. Якщо обидва"
echo "  контролі однакові — проба сліпа, висновків не робимо."

[ "${1:-}" = "--paid" ] || { echo; echo "Для платної перевірки форми запиту: --paid"; exit 0; }

echo
echo "=== 3. Чи приймає sunburst quality=max і довільний розмір (ПЛАТНО, ~1 запит) ==="
curl --config "$CFG" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-2.5-sunburst","prompt":"a plain grey square","size":"1024x1024","quality":"max","n":1}' \
  https://api.openai.com/v1/images/generations \
  | python3 "$HERE/check-models.py" generation
