#!/usr/bin/env python3
"""Розбирає відповідь OpenAI на STDIN. Режим: `models`, `probe` або `generation`."""
import json
import sys

WANT = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2',
        'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini']


def fail(msg):
    print('  ✗ ' + msg)
    sys.exit(1)


def parse(raw):
    if not raw.strip():
        fail('порожня відповідь — схоже, запит не дійшов (мережа або фаєрвол)')
    try:
        return json.loads(raw)
    except ValueError as e:
        fail('відповідь не JSON (%s): %s' % (e, raw[:200]))


def probe():
    """Чи існує модель для цього ключа — питаємо сам ендпоінт генерації.

    ⚠️ ЧОМУ НЕ /v1/models. Той ендпоінт — каталог, а не право доступу: він
    показує те, що OpenAI вирішив у ньому показати, і нові image-моделі туди
    доїжджають із запізненням. Судити з нього про доступність — означає
    впевнено сховати модель, якою користувач насправді може працювати.

    Запит навмисно невалідний (size=1x1), тому нічого не генерує і не коштує.
    Читаємо не результат, а те, на ЧОМУ саме він упав:
      • model_not_found / 404  → ключ моделі не має;
      • скарга на size          → модель прийнято, запит дійшов до параметрів.
    Обидва висновки вартують рівно стільки, скільки контрольні рядки поруч:
    якщо завідомо неіснуюча модель відповідає так само, як справжня, — проба
    нічого не розрізняє, і скрипт мусить це сказати, а не вгадувати.
    """
    raw = sys.stdin.read().rsplit('\n', 1)
    body = parse(raw[0])
    code = (raw[1] if len(raw) > 1 else '').strip()
    err = body.get('error') or {}
    ecode = err.get('code') or err.get('type') or ''
    msg = err.get('message') or ''

    if code == '401' or ecode == 'invalid_api_key':
        print('✗ ключ не прийнято (401) — далі перевіряти нічого')
        sys.exit(1)
    if code == '404' or ecode == 'model_not_found' or 'does not exist' in msg:
        print('НЕМА ДОСТУПУ — %s' % (msg or ecode or code))
        return
    # ⚠️ Не шукати слово «size» у тексті: OpenAI пише «Invalid value: '1x1'…»,
    # а назва поля живе в err.param. Перша версія цієї перевірки саме тому
    # відносила справжню відмову по розміру в «?? незрозуміло».
    if err.get('param') == 'size' or 'size' in msg.lower():
        print('ДОСТУПНА — модель прийнято, впало на розмірі (саме це й перевіряли)')
        return
    # Щоб поскаржитись на будь-який ІНШИЙ параметр, API мусив спершу розібрати
    # модель. Отже 400 не про модель — це теж доказ доступу, лише слабший.
    if code == '400' and 'model' not in msg.lower():
        print('ДОСТУПНА (ймовірно) — відмова не про модель, а про «%s»: %s'
              % (err.get('param') or ecode, msg[:80]))
        return
    if not err:
        print('?? відповідь без помилки (HTTP %s) — проба не спрацювала як задумано' % code)
        return
    print('?? HTTP %s / %s — %s' % (code, ecode, msg[:120]))


def models():
    body = parse(sys.stdin.read())
    if isinstance(body, dict) and body.get('error'):
        err = body['error']
        fail('API відмовив: %s — %s' % (err.get('code') or err.get('type'), err.get('message')))
    data = body.get('data')
    if not isinstance(data, list):
        fail('несподівана форма відповіді')
    ids = sorted(m.get('id', '') for m in data if 'image' in m.get('id', ''))
    for w in WANT:
        print(('  ✓ ' if w in ids else '  — ') + w)
    extra = [i for i in ids if i not in WANT]
    if extra:
        print('\n  є в каталозі, але НЕ в плагіні: ' + ', '.join(extra))
    if [w for w in WANT if w not in ids]:
        print('\n  «—» означає лише «немає в каталозі». Чи є доступ — покаже крок 2.')


def generation():
    body = parse(sys.stdin.read())
    if isinstance(body, dict) and body.get('error'):
        err = body['error']
        fail('API відмовив: %s — %s' % (err.get('code') or err.get('type'), err.get('message')))
    usage = body.get('usage') or {}
    print('  ✓ запит прийнято; usage: ' + json.dumps(usage))
    b64 = ((body.get('data') or [{}])[0] or {}).get('b64_json') or ''
    print('  байтів у відповіді: %d' % len(b64))


{'models': models, 'probe': probe, 'generation': generation}[
    sys.argv[1] if len(sys.argv) > 1 else 'models']()
