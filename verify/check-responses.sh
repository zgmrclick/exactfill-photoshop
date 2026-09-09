#!/usr/bin/env bash
# Що насправді вміє інструмент image_generation у /v1/responses.
#
# Ключ береться з оточення і НІКУДИ не пишеться. Запуск:
#   OPENAI_API_KEY='sk-...' ./verify/check-responses.sh
#
# Скрипт нічого не витрачає: КОЖЕН запит навмисно невалідний і відсікається
# валідатором до генерації. Цінність — не в успіху, а в тексті відмови:
# сервер перелічує допустимі значення поля, про яке ми спитали дурницю.
set -uo pipefail

: "${OPENAI_API_KEY:?поставте OPENAI_API_KEY у середовищі}"
CFG="$(mktemp)"; trap 'rm -f "$CFG"' EXIT
printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\nsilent\nshow-error\n' \
    "$OPENAI_API_KEY" > "$CFG"
URL=https://api.openai.com/v1/responses

# Друкує код відповіді і повідомлення про помилку — те єдине, що нас цікавить.
ask() {
    local label="$1" body="$2"
    printf '\n--- %s\n' "$label"
    curl --config "$CFG" -w '\n%{http_code}' -d "$body" "$URL" | python3 -c '
import json, sys
raw = sys.stdin.read().rsplit("\n", 1)
code = raw[-1].strip()
try:
    j = json.loads(raw[0])
except Exception:
    print(f"    HTTP {code}: {raw[0][:300]}")
    sys.exit()
err = j.get("error") or {}
msg = err.get("message") or json.dumps(j)[:400]
print(f"    HTTP {code} [{err.get(\"param\") or err.get(\"code\") or \"-\"}]")
for line in msg.split(". "):
    print(f"      {line}")
'
}

echo "=== 1. Яка модель приймає сам ендпоінт /v1/responses ==="
ask "top-level model = gpt-image-2 (наша модель зображень)" \
    '{"model":"gpt-image-2","input":"x","tools":[{"type":"image_generation"}]}'

echo
echo "=== 2. Чи є в інструмента власне поле model і що воно приймає ==="
ask "tools[0].model = zzz-nonexistent" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","model":"zzz-nonexistent"}]}'
ask "tools[0].model = gpt-image-2.5-sunburst (те, чим користуємось)" \
    '{"model":"gpt-5.6","input":"","tools":[{"type":"image_generation","model":"gpt-image-2.5-sunburst"}]}'

echo
echo "=== 3. Рівні якості інструмента ==="
ask "tools[0].quality = zzz" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","quality":"zzz"}]}'

echo
echo "=== 4. Розміри інструмента ==="
ask "tools[0].size = 1x1" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","size":"1x1"}]}'

echo
echo "=== 5. Маска: чи є шлях повз Files API ==="
ask "input_image_mask.image_url = data:… (хочемо уникнути завантаження файлу)" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","input_image_mask":{"image_url":"zzz"}}]}'
ask "input_image_mask.file_id = zzz (задокументована форма — контроль)" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","input_image_mask":{"file_id":"zzz"}}]}'

echo
echo "=== 6. Багатохідність: посилання на попередній виклик ==="
ask "input[] містить image_generation_call з вигаданим id" \
    '{"model":"gpt-5.6","input":[{"role":"user","content":[{"type":"input_text","text":"x"}]},{"type":"image_generation_call","id":"ig_zzz"}],"tools":[{"type":"image_generation"}]}'

echo
echo "=== 7. Інші поля інструмента (input_fidelity, background, output_format) ==="
ask "input_fidelity = zzz" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","input_fidelity":"zzz"}]}'
ask "output_format = zzz" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","output_format":"zzz"}]}'
ask "background = zzz" \
    '{"model":"gpt-5.6","input":"x","tools":[{"type":"image_generation","background":"zzz"}]}'
