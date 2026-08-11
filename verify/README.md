# verify/ — сирі виміри в живому Photoshop

Не документація й не тести CI. Це **протоколи вимірювань**: що саме спитали в Photoshop і
що він відповів. Тримаємо в репо, бо `place.js` спирається на ці числа, а не на документацію
Adobe (batchPlay-ID Adobe не документує взагалі).

Прогнано на **Photoshop 27.5.0** (2026 / PHSP 27), macOS 25.5.0, 2026-08-11.

## Як це запускалось

Через AppleScript-канал, без участі користувача:

```bash
osascript -e 'tell application "Adobe Photoshop 2026" to do javascript "String($.evalFile(new File(\"/path/probe6.jsx\")))"'
```

`do javascript` виконує **ExtendScript**, а не UXP. Це важливо і достатньо: `executeAction`
і `batchPlay` — два фасади над одним Action Manager, тому descriptor `{_obj:'transform',
width:{_unit:'percentUnit'}}` у batchPlay і `putUnitDouble(sID('width'), sID('percentUnit'))`
в ExtendScript ідуть в один і той самий виклик. Що **не** переноситься — модуль `imaging`
(його в ExtendScript немає); для нього є `../verify-assumptions.psjs`.

Форма `do javascript file (POSIX file … as alias)` віддає помилку 8800 — тому `$.evalFile`.

Тестові PNG генерує `gen_test_pngs.js` **нашим власним** `../png.js` — заодно перевірка
fixed-Huffman deflate проти реального декодера Photoshop, а не лише проти `zlib`:

```bash
node verify/gen_test_pngs.js /tmp/psverify
```

Усі скрипти створюють свої документи й закривають без збереження; документи користувача не
чіпають (кожен звіт починається з рядка «documents already open»).

## Що в якому файлі

| Файл | Що міряв | Головне |
|---|---|---|
| `report.txt` | перший широкий прогін, 10 передумов | `transform rect→quad` = **тихий no-op**; `place` CMYK/16-біт **не конвертує**; `pHYs` працює; наш PNG читається |
| `probe2.txt` | 7 механізмів переміщення SO | `resize(%,TOPLEFT)`+`translate` = EXACT; `nonAffineTransform` присутній **завжди** |
| `probe3.txt` | пошук descriptor-а без DOM | `transform QCSAverage + width/height %` = EXACT; `distanceUnit` у `move` — **пункти**, не пікселі |
| `probe4.txt` | матриця 13 кейсів, 6 колірних режимів | 13/13 EXACT; дробовий зсув **не** підтримується |
| `probe5.txt` | `move` з `pixelsUnit`; маска з альфа-каналу | обидва коректні; маска в CMYK 16-біт обрізала `layer.bounds` рівно у виділення |
| `probe6.txt` | **алгоритм, який реально в `place.js`** | **14/14 EXACT, один прохід, жоден документ не сконвертовано** |

`probe6` — єдиний, що є дослівним переносом кроків 4–5 `place.js`. Решта — розвідка, яка до
нього привела. Якщо `place.js` міняється, переписати треба `probe6.jsx` і прогнати ще раз.

## Як перепрогнати

```bash
node ~/ai-image-ps/verify/gen_test_pngs.js /private/tmp/psverify
```

Далі підправити константу `DIR` у потрібному `.jsx` і виконати `osascript`-рядок вище.
Photoshop мусить бути запущений; `pgrep -x "Adobe Photoshop 2026"` це показує.
