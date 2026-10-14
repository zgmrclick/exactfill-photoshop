# Платформа: граблі Photoshop/UXP і рішення

Що не видно з коду: чому так зроблено, що пробували й відкинули, що виміряно в хості всупереч
документації. Сигнатури модулів — `CONTRACTS.md`, сирі виміри — `verify/README.md`.
Виміри — Photoshop 27.5 (2026), macOS, якщо не сказано інше.

## ⚠️ Головне: imaging API не працює поза RGB

- `imaging.getPixels` / `putPixels` / `createImageDataFromBuffer` / `getSelection` — **лише RGB,
  Grayscale, Lab**. У CMYK `getData()` **валить Photoshop** (SIGSEGV); Bitmap/Indexed/Multichannel
  падають gracefully. У `putPixels` немає `colorSpace`, а `createImageDataFromBuffer.colorSpace` CMYK
  не приймає → CMYK-`imageData` не сконструювати → будь-який маршрут через `putPixels` змушує
  конвертувати весь документ.
- **Читати не-RGB:** `doc.duplicate()` → `convertMode` на **копії** → `saveAs.jpg` → закрити копію.
  Перед `convertMode` перевіряти `app.activeDocument.id === dup.id`: без `_target` команда діє на
  активний документ.
- **Вставляти:** `placeEvent` із session token файлу — Photoshop сам конвертує колір, документ лишається
  CMYK/16-біт. Далі виміряти рамку → масштаб → `move`.
- `componentSize: 8` у `getPixels` замінює `convertMode depth:8`, але з 16-бітного документа буває
  «Photoshop Error. Code: -1» (регресія з PS 26.3) — завжди мати фолбек на дублікат.
- Діапазон 16-біт в UXP — `[0..32768]`, не `[0..65535]`: ручне `>>8` дає вдвічі темніше. Не конвертувати
  вручну — просити `componentSize: 8`.

## Пробували і відкинули

| Що | Чому |
|---|---|
| Лікувати зсув вставки `Math.round` | Округлення центру саме дало детермінований зсув +1 px при непарній ширині. Контур був розімкнутий: код не читав, де шар опинився. Лікування — виміряти after-стан |
| `putPixels` + `newPlacedLayer` + `transform` | Вимагає RGB 8-біт → конвертація CMYK→RGB→CMYK необоротна (100 %K стає rich black), SO зберігає дробову геометрію → напівпрозорі краї |
| `convertMode` на живому документі + відкат історії | На етапі вставки відкат зняв би й саму вставку |
| PNG зі stored-deflate | Маска 1024² = рівно 4 MiB при ліміті OpenAI <4 MB. Потрібен справжній deflate (fixed-Huffman + RLE) |
| `transform` `rectangle`→`quadrilateral` для абсолютної рамки SO | **Не робить нічого й повертає успіх** — у всіх варіантах одиниць. Ловиться лише виміром |
| `transform` з `offset` + percent | `offset` рахується не від центру рамки — шар їхав на 1200–1800 px. Позицію — окремим `move` |
| `batchPlay({_obj:'feather'})` | Системний діалог «команда недоступна». Брати DOM `selection.feather(radius, true)` (PS 25+) |
| descriptor `{_ref:'channel', _enum:'channel', _value:'selection'}` | Хибний (selection — property reference): канал і резервна маска тихо не створювались. Брати `selection.save/load/selectRectangle` |
| Фільтр/позначка моделей за `/v1/models` OpenAI | Каталог ≠ доступ (див. «Моделі») |
| `chatgpt-image-latest` | Лише фіксовані розміри (вбиває точну вставку), рухома ціль і рухома ціна при статичних `caps`/`usage.js` |
| Windows one-click скрипти (`deploy.ps1`, `.cmd`) | Прив'язка до версії Photoshop і PowerShell/UAC — крихко. Канон — один ZIP |

## Виміряно в хості — чого документація не каже

- **`smartObjectMore.transform` — координати документа**, 8 чисел TL→TR→BR→BL, `double`.
  `layer.bounds` для виміру не годиться: лише непрозорі пікселі в межах канви.
- `place` **не конвертує документ** (CMYK 8/16, RGB 16/32, Gray 16) — один крок в історії.
- **`distanceUnit` у `move` — пункти (1/72″)**, не пікселі. Правильно — `pixelsUnit`.
- `nonAffineTransform` присутній завжди й після чистого `place` дублює `transform`; перекіс — це розбіжність, не присутність.
- Дробового зсуву нема (`move(0.25, −0.75)` → `(0, −1)`); після масштабу Photoshop сам прилипає до цілого.
- Smart Object тримає нативний растр — повторні масштабування не деградують.
- **`pHYs` усуває PPI-масштабування Place** (без нього 1024 px у 300-ppi стає 4266.667). Тому
  **`output_format` OpenAI мусить лишатись `png`**: у WebP поля роздільності нема. JPEG Gemini ставиться
  рівно незалежно від JFIF density.
- Fit-to-canvas реальний (1024 у канві 800×600 → 600×600), але при «виміряти → діяти» це лише ресемпл.
- **`getSelection` ігнорує `sourceBounds`** — повертає рамку самого виділення. Читати `res.sourceBounds` і
  блітити у свій буфер за зсувом. Node-стаб цього не показує.
- Adobe не документує batchPlay-ID — відсутність у довіднику не ознака ризику; перевіряти записом дії
  (Alchemist) або `.psjs`.

## Дві маски, і вони різні

- **Маска запиту** (`png.js:buildRectMaskPng`) — завжди прямокутник bbox виділення; alpha 0 = змінити.
  Йде лише при контексті > 0 (при 0 кадр = виділенню). Відступ — від довшої сторони (`expandForContext`).
- **Маска шару** (`place.js:applySelectionMask`) — справжня форма через канал (`selection.save` → `load` →
  reveal). Ласо захищає документ, але не запит: модель отримує прямокутну дірку й платимо за bbox.
  Змінили виділення під час генерації → фолбек на прямокутну маску, видно в `residual.rectMask`.
- **Маска PNG + вхід JPEG = маска мовчки не діє** (OpenAI вимагає однаковий формат і розмір, сервер не
  сварить). Вище `LOSSLESS_MAX_PX` вхід деградує в JPEG → баг «модель не бачить виділення» плаває.
  Рішення про маску й формат — одна функція `inputPlan()`; гейт рахує кількість копій формули.
- М'який край шару: UI = повна ширина переходу; `radius = width/2`, `selection.contract(radius)` і
  `feather(radius)` — перехід усередині виділення (симетричний feather обривався лінією на краю SO).
  Радіус ≤ чверть меншої сторони − 1. Діапазон UI 0–256 px.
- Режим «лише активний шар»: на дублікаті рекурсивно лишати видимою гілку активного шару (видалення
  top-level сусідів знищить вкладений шар разом із групою).

## Моделі

- **Усе знання — у `caps` моделі** (розмір, рівні якості, `inputFidelity`, `stablePx`). Рядкові винятки за
  назвою ламали чотири файли частково. Нова модель — `MODELS` + ціна в `usage.js`; гейт — `test/models.test.js`.
- Рівні `xhigh`/`max` приймає лише 2.5 (інші → 400). `coerceQuality` зводить **лише вниз**, і зведене
  не пишеться в localStorage (там побажання користувача).
- `xhigh`/`max` не дають більше пікселів за `high` — купують зусилля рендера. **Вихідні токени не ростуть
  із площею** (3.6 МП max = ~5400 токенів).
- **OpenAI `/v1/models` — каталог, а не право доступу**: нові моделі працювали, хоча в каталозі їх не
  було. `models()` OpenAI у мережу не ходить (гейт-тест). Для Google навпаки — ListModels є правдою.
- Безкоштовна проба доступу: навмисно невалідний запит (`size=1x1`), читати причину відмови
  (`model_not_found` vs скарга на `size`). **Завжди з контролями** (реальна й неіснуюча модель). Скрипт —
  `verify/check-models.sh`. Gemini: `countTokens` з контролем; порожнє тіло `generateContent` не розрізняє.
  Розвідка полів Gemini: `contents: []` + поле → `Unknown name` / `Invalid value` / валідне.
- **Вимкнення — `RETIRED` за датою** (`Map id → {shutdown, replacement}`): реліз живе в користувачів
  місяцями. Ховається з 00:00 UTC дня вимкнення; заміна — явна (mini → Flare, не `list[0]`, щоб не
  підняти рахунок мовчки); 404 на вимкненій → `error.modelRetired`. Ціни вимкнених лишаються в `usage.js`.
  Тести не прив'язувати до моделі, що вимикається.
- Google: ID нових моделей може не містити `-image` → розбір каталогу — `pickImageModels()`; **порядок
  `FALLBACK_MODELS` = дефолт**. ListModels перелічує й вимкнені. Дати вимкнення звіряти на обох сторінках
  Google (pricing і deprecations суперечать).
- **Gemini `generateContent` віддає лише JPEG** (`IMAGE_JPEG` — єдине валідне значення). `png.prepareForPlace()`
  визначає формат за байтами.
- Багатохідне уточнення в `/v1/responses` — лише `previous_response_id`: подати `image_generation_call`
  за id з міркувальною моделлю-господарем → 400 (бракує `reasoning`-предка). Інструмент приймає своє поле `model`.
- Preview лише в OpenAI-потоці: обов'язково `partial_images:3` (типово 0 = лише фінал); SSE може йти з CRLF.
  Gemini — `generateContent` без проміжних; міграція на Interactions API — окрема робота.

## Мережа і транспорт через curl

- `network.domains` не обходить фаєрвол: запит іде з процесу Photoshop. Потрібен лише вихідний HTTPS
  до `api.openai.com` / `generativelanguage.googleapis.com`. У Windows Defender `Block Photoshop`
  сильніший за `Allow`.
- **Заблокований fetch не падає, а висить.** Тому `auto` робить **keyless preflight на 6 с** до першого
  запиту (будь-яка HTTP-відповідь = шлях живий) і вміє відкотитися назад.
- Маршрут curl (`providers/curl-transport.js`): UXP → session token → `batchPlay` `AdobeScriptAutomation Scripts`
  → ExtendScript `app.system("curl … &")` → пулінг файла. Виміряно: **блок фаєрвола на Photoshop дочірній
  curl не накриває** (macOS, правила per-binary); файл `-o` росте під час завантаження → SSE-preview живий.
  Доменне/шлюзове блокування цим не обходиться.
- Форми, що не працюють: `{_path: '/abs'}` → `invalid file token`; `javaScript: '<рядок>'` → `-128`;
  `.psjs` цією подією не запускається; `createPersistentToken` не потрібен. Результат batchPlay містить
  `javaScriptMessage` — двосторонній канал. У UXP `fs` немає `unlinkSync`.
- **Ключ API — лише у файлі `--config`** (не argv, видно в `ps`) → прибирання тимчасових файлів — єдине,
  що прибирає ключ: `try/finally` у `curlFetch`, прибирання стріму навіть при винятку в обробнику.
- Код виходу — з `-w "%{http_code} %{exitcode}"` у файл (після `start /b` коду нема). curl exit 6 —
  адресу не визначено (свіжий блок фаєрвола), 7 — відкинуто, 28 — таймаут або фаєрвол ще питає.
  Фаєрвол без рішення (LuLu-алерт) дає **зависання**, не відмову — 20 с ≠ блок; повторити після правила.
- Windows: `curl.exe` штатно є, Defender `AllowOutbound` → без діалогу. ⚠️ Кодова сторінка 866 —
  робочі файли лише в ASCII-шляху (`%PROGRAMDATA%\ExactFill`); у cmd фон — `start /b ""`.
  **Паритет Windows не заявляти**, доки не перевірено в справжньому Photoshop на Windows.
- Окремий `.psjs` не має мережевих дозволів (sandbox без manifest) — це не фаєрвол.

## UXP UI

- **Поле вводу без `maxlength` мовчки глушить ввід ~256 символів** — недокументований дефолт UXP.
  Не рендер і не бокс. Гейт: кожне поле оголошує `maxlength`. `rows`/`cols` у textarea ігноруються — висота CSS.
- Усі `<script src>` з `index.html` ділять **один lexical scope**: однакові top-level `const` валять панель
  (`Identifier … already declared`). Імпорт іменувати по-різному в кожному файлі. CommonJS — окремий scope.
- `display:grid` у PS 27 прибирав контроли без помилки → критична геометрія лише `flex`. `:empty` і
  `:nth-child` UXP ігнорує — класи ставить JS. `box-sizing` не глобальний: `flex-basis 33.333 %` + border
  дав 2 в ряд замість 3 → `border-box` + `flex: 1 1 30%`. **Браузерний стенд не міряє UXP-розкладку.**
- `sp-number-field` не малюється → `sp-slider` з фолбеком на сегменти (`[ui] sp-slider не намалювався` у
  лозі — штатно). `sp-picker` після асинхронного наповнення не перемальовує trigger → збирати новий picker
  поза DOM з готовими options і `value`, замінити, перевісити `change`.
- Hybrid: Spectrum `sp-picker`/`sp-checkbox` + власні `<button>` з inline SVG. CSS-border chevron
  ламається; SVG logo без gradient/`defs`.
- Viewport-shell: `html/body` 100 % без скролу, нерухомий `.brand-bar`, скролить `#main.panel-scroll`
  (`min-height:0; overflow-y:auto`). Мінімум 230 px без горизонтального overflow.
- Іконка панелі — PNG RGBA 8-біт 23×23/46×46; у manifest `panel-dark.png`, на диску `@1x`/`@2x`, окремо
  light/dark з `species: "toolbar"`. Зміна іконок — нова patch-версія (кеш метаданих).
- Manifest: `localFileSystem: "request"`, домени, `launchProcess.schemes: ["https"]`. Promise від
  `openExternal` і secureStorage завжди обробляти.
- Runtime без абсолютних шляхів і `.nativePath`; регістр `require` — точний (Windows).
- Панель UXP не потрапляє в захоплення вікна (малюється окремим шаром) — лише повноекранний знімок;
  синтетичний `cmd+V` у поле не приймається.

## Сховище, витрати, збірка

- `secureStorage` і `localStorage` ізольовані **per manifest id** → id лишився `ai-image-ps` після
  перейменування на ExactFill, щоб не втратити ключі. Ключі localStorage — лише в `storage-keys.js`.
- Витрати — журнал `ai_usage_ledger_v1` (localStorage переживає перезапуск, «за сесію» хибне): ціна
  фіксується в записі на момент запиту, пишеться **до** вставки (оплата вже є). Токени: OpenAI
  `input_tokens_details` + `output_tokens`; Gemini — за модальностями (не множити `candidatesTokenCount`
  на текстову ставку — там і картинка). Джерела цін — поруч із таблицею в `usage.js`.
- Власний deflate: `distance ≤ 32768` (RFC 1951) — для широких полотен відстань «попередній рядок»
  вимикається; поріг площі `LOSSLESS_MAX_PX` вікно ширини не рятує.
- Новий кореневий `*.js` → `ROOT_FILES` у `scripts/build-release.sh`. Не-рантайм → `--exclude` у
  `deploy.sh` (Photoshop сканує `Plug-ins` на кожному старті; `--delete-excluded` обов'язковий —
  `--delete` виключене не прибирає). Git-репо в `Plug-ins` не тримати.

## ⚠️ Клас багу: тест зелений на тому, чого в бою немає

Траплялось у `presets.js` (тест кликав `load()` сам, панель — ніколи), `curl-transport.js` (тестували
`buildCommand`, у бою — інша функція без екранування), списку файлів ZIP (літеральний список у тесті),
довжині URL звіту (GitHub 414). **Правило:** перевіряєш функцію — перевір, що саме її викликають
(статичний тест по тексту джерела); списки файлів виводити з ФС. Те саме — «тихе зниження функції»
(`images/generations` замість `edits` без помилки): у провайдерах лог-рядок про фактичний ендпоінт.

## Як перевіряти без Photoshop і в Photoshop

- `node --test test/main-boot.test.js` — увесь `initUI` під node (`test/stubs/dom.js`, DOM з реального
  `index.html`). «Жодного `console.error`» = ініціалізація пройшла повністю. Розкладку не ловить.
- Живий Photoshop з термінала (macOS): `osascript -e 'tell application "Adobe Photoshop 2026" to do
  javascript "String($.evalFile(new File(\"/tmp/probe.jsx\")))"'`. Це ExtendScript (ES3, без `JSON`),
  але `executeAction` і `batchPlay` — один Action Manager. Скрипт в ASCII; `rulerUnits = PIXELS` і
  відновлення у `finally`; свої документи закривати `DONOTSAVECHANGES`. Форма `do javascript file` — 8800.
- Після деплою — новий `UXPLogs_*.log`: без `SyntaxError|ReferenceError|TypeError`. Метрика вставки —
  `report.residual` = 0.
