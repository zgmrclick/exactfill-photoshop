# Контракти модулів — ЄДИНЕ ДЖЕРЕЛО ІСТИНИ

Плагін `ai-image-ps`. Один сценарій: прямокутне виділення → промпт → провайдер/модель/якість
→ Smart Object точно на місці виділення. RGB і CMYK, 8/16/32 біт.

**Не змінювати сигнатури нижче без правки цього файлу.** Модулі пишуться незалежно й мусять
зійтися з першої спроби.

---

## `geometry.js` — ГОТОВО, не чіпати

Чистий модуль, без `require('photoshop')`. Протестований у node.

```js
unwrap(n)                          // {_unit,_value} → number, або number як є
integerTarget(bounds)              // → {left,top,right,bottom,w,h}  цілі; округлює КРАЙ, не ширину
planFrame(target, nat)             // nat={w,h} нативний PNG → {mode:'exact'|'cover',left,top,right,bottom}
planRequest(caps, target, quality) // → {size:'WxH',quality} | {aspectRatio:'W:H',imageSize:'2K'}
exactSize(target, caps, quality)   // → 'WxH' | null
QUALITY_BUDGET                     // {low:1.2e6, medium:3e6, high:8294400, auto:3e6}
```

`caps` — опис ГЕОМЕТРИЧНИХ можливостей моделі:
```js
{ arbitrary:true, step:16, maxEdge:3840, minPx:655360, maxPx:8294400, maxRatio:3 } // gpt-image-2
{ arbitrary:false, sizes:['1024x1024','1536x1024','1024x1536'] }                   // gpt-image-1/1.5/mini
{ arbitrary:false, aspects:['1:1','3:2',…], imageSizes:['1K','2K','4K'] }          // gemini
```

## `place.js` — ГОТОВО, не чіпати

```js
placeGeneratedSmartObject(b64, bounds, channelName) // → report; ВИКЛИКАТИ У executeAsModal
withPixels(params, fn)                              // getPixels + dispose у finally
setPngResolution(pngBytes, ppi)                     // вписує чанк pHYs
readPngSize(pngBytes)                               // → {w,h} з IHDR
```

`report = { mode, nat:{w,h}, target, applied, residual:{dx,dy,dw,dh}, warnings:[] }`
`residual` — головна метрика точності, мусить бути 0.

---

## `capture.js` — ПИСАТИ

Один конвейєр захоплення на весь плагін. **Ніде більше `imaging.getPixels` не викликати.**

```js
/**
 * Захоплює пікселі виділеної області як JPEG.
 * Викликати ВСЕРЕДИНІ core.executeAsModal.
 * @param {{left,top,right,bottom}} bounds — цілі межі (з geometry.integerTarget)
 * @param {boolean} useLayerOnly — брати лише активний шар, не зведене
 * @returns {Promise<{blob: Blob, docMode: string, bpc: number, viaDuplicate: boolean}>}
 */
async function captureRegion(bounds, useLayerOnly = false)
module.exports = { captureRegion, buildRectMaskPng };
```

Обов'язкові вимоги:

1. **Whitelist за `doc.mode`.**
   - `RGBColorMode` / `GrayscaleMode` / `LabColorMode` → напряму:
     ```js
     imaging.getPixels({ sourceBounds, applyAlpha:false, layerID?,
       colorSpace:'RGB', colorProfile:'sRGB IEC61966-2.1', componentSize:8 })
     ```
     `componentSize:8` замінює `convertMode depth:8`. `colorProfile` обов'язковий —
     без нього конверсія недетермінована (відомий баг «black or negative colors»).
   - **усе інше** (`CMYKColorMode`, Indexed, Duotone, Multichannel, Bitmap) → шлях через копію:
     ```js
     const dup = await doc.duplicate();
     try {
       await batchPlay convertMode → RGBColorMode (merge:false, flatten:false)
       await batchPlay convertMode → depth 8
       await dup.crop(bounds)            // або selection + crop
       await dup.saveAs.jpg(tempFile, { quality: 12 }, true)
       // прочитати байти tempFile → Blob
     } finally { await dup.closeWithoutSaving(); }
     ```
     **Документ користувача не торкати ніколи.** Жодного `convertMode` на `app.activeDocument`.
     Причина: `getPixels`/`getData()` у CMYK **валить Photoshop** (PS 26.9), а `putPixels`
     CMYK не приймає в принципі — `createImageDataFromBuffer.colorSpace` документує лише
     RGB/Grayscale/Lab.

2. **Фолбек на 16/32 біт.** Є ризик, що `componentSize:8` з 16-бітного документа кидає
   «Photoshop Error. Code: -1» (регресія з PS 26.3). Тому: спробувати `componentSize:8`,
   і **при будь-якій помилці** тихо перейти на шлях через копію. Не намагатися конвертувати
   вручну — старий `encodeAs8BitJpeg` робив `>>8` при діапазоні 16-біт [0..32768], через що
   зображення виходило вдвічі темнішим.

3. **`withPixels` із `place.js`** — усе, що отримує ImageData, мусить іти через нього.
   ImageData не має перетинати межу функції.

4. **`buildRectMaskPng(ctxW, ctxH, rect)`** — маска inpainting для прямокутної області.
   `rect` у координатах контексту. Alpha=0 (прозорий) = «змінити тут», alpha=255 = «зберегти».
   **НЕ використовувати stored-deflate** — старий `encodeMaskPNG` давав 4.00 MiB для 1024²
   при ліміті OpenAI «<4MB». Варіанти: (а) 1-бітний PNG grayscale+tRNS, (б) справжній deflate
   через RLE-подібне кодування однакових рядків, (в) тимчасовий документ + `saveAs.png`.
   Для прямокутника рядки повторюються, тому (а) або (б) дають кілобайти.

---

## `providers/openai.js`, `providers/google.js`, `providers/index.js` — ПИСАТИ

```js
// providers/index.js
module.exports = {
  list(),          // → [{id:'openai',label:'OpenAI'},{id:'google',label:'Google'}]
  get(id),         // → provider | null
};

// кожен provider:
module.exports = {
  id: 'openai',
  label: 'OpenAI',
  keyName: 'openAiApiKey',                 // ключ у storage.secureStorage
  async models(apiKey),                    // → [{id,label,caps}]  caps — див. geometry.js
  supportsMask: true,                      // Gemini — false
  /**
   * @param {{apiKey,model,prompt,imageBlob,maskBlob,plan,n,onProgress}} o
   *   plan — те, що віддав geometry.planRequest (кладеться в payload як є)
   *   onProgress(current,total,status,error)
   * @returns {Promise<string[]>}  масив base64 PNG. БІЛЬШЕ НІЧОГО.
   */
  async generate(o),
};
```

Джерело коду — старі SDK, але **чистити**:

**OpenAI** (`GPT-imagePluginPS/openAiSdk.js`):
- лишити `generateImage` (POST `images/generations`) і `editImage` (POST `images/edits`, multipart)
- **видалити** `generateImageWithContext` + весь `/v1/responses` (імпортується, не викликається
  ніде), `refinePrompt`, `generateChat`, мертві `OPENAI_IMAGE2_SIZES`/`OPENAI_IMAGE1_SIZES`
- моделі й `caps`: `gpt-image-2` → `arbitrary:true` (решта — фіксовані три розміри);
  `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini` → `sizes:['1024x1024','1536x1024','1024x1536']`
- `input_fidelity:'high'` — для всіх, **крім** `gpt-image-2` (він і так обробляє на high, параметр
  для нього недоступний)
- **додати retry на 429** з `Retry-After` і експоненційним backoff. Не ретраїти 400/401/403.
- таймаут мусить **скасовувати** запит (`AbortController`), а не лише відкидати проміс,
  і таймер чистити в `finally`
- формат відповіді перевіряти: якщо немає `data[i].b64_json` — кидати читабельну помилку,
  а не падати в `atob`

**Google** (`NanoBananaPluginPS/googleAiSdk.js`):
- лишити `generateContent`-шлях (`gemini-*-image`), викинути **весь Imagen** (shutdown 2026-08-17)
- **повернути** `generationConfig.imageConfig.{aspectRatio,imageSize}` — коментар у старому коді
  «не документоване поле» ХИБНИЙ. `imageSize` пише велику «K»: `'1K'|'2K'|'4K'`.
  `responseModalities:['TEXT','IMAGE']` лишається обов'язковим.
- моделі: `gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`.
  **Видалити** `gemini-1.5-*`, `gemini-2.0-flash-exp`, усі `imagen-3.0-*`.
- ключ **не в query-рядку URL** — заголовок `x-goog-api-key`
- перевіряти `finishReason` і `promptFeedback`: safety-блок мусить давати людський текст,
  а не `TypeError`
- `supportsMask:false` — параметра маски немає. Область показувати через контекст із заливкою.

---

## `main.js` — ПИСАТИ, цільовий обсяг ≤ 300 рядків

Єдиний потік. Ніякої іншої логіки в файлі бути не має.

```
1. Гейт (НЕ модально):
   doc = app.activeDocument            → нема: alert «Відкрийте документ»
   sel = doc.selection.bounds          → null: alert «Виділіть область»
   doc.selection.solid === false       → попередження «сценарій для прямокутного виділення»
   Кнопка Generate блокується на весь час роботи (зараз її можна натиснути двічі).

2. target = geometry.integerTarget(sel)
   provider = providers.get(localStorage.provider)
   model, quality, n — з UI
   plan = geometry.planRequest(caps, target, quality)

3. executeAsModal → capture.captureRegion(target, useLayerOnly) → {blob}
   Маска: якщо provider.supportsMask і CONTEXT_PAD > 0 — capture.buildRectMaskPng(...)

4. НЕ модально → provider.generate({...}) → base64[]

5. executeAsModal → для кожного b64:
     place.placeGeneratedSmartObject(b64, target, channelName)
   Перед циклом — зберегти виділення в тимчасовий канал; у finally видалити канал.
   Логувати report.residual кожної вставки.

6. Перевірка, що документ ТОЙ САМИЙ, що на кроці 3 (порівняти doc.id) — інакше alert і вихід.
```

Обов'язково:
- зберігати в `localStorage`: `provider`, `model`, `quality`, `n`, `prompt`, `useLayerOnly`
- **жодного `saveDebugBlob`** — він намив 3 ГБ у 484 файлах
- усі `catch` показують користувачу текст помилки; тихого `return null` не має бути ніде

## `index.html` + `style.css` — ПИСАТИ

Одна панель, без вкладок. Елементи:
промпт (textarea) · провайдер (sp-picker) · модель (sp-picker) · якість (4 кнопки
low/medium/high/auto) · к-сть варіацій (sp-number-field 1-4) · «лише активний шар» (checkbox) ·
Generate + спінер · секція пресетів (згортається) · секція історії (згортається) · керування API-ключами.

**Викинути:** вкладки Grid і Chat, Refine-prompt, Whole-Image/Gen-Fill, Upscale,
Reference images, тумблер контексту.
`style.css` — узяти зі старого й вирізати правила мертвих блоків (з 1600 рядків лишається ~700).

## `manifest.json` — ПИСАТИ

```
id: ai-image-ps            name: AI Image
host.app PS, minVersion "25.0.0"      ← doc.selection.bounds/.solid з 25.0
manifestVersion 5
requiredPermissions.localFileSystem: "request"
requiredPermissions.network.domains: ["https://api.openai.com",
                                      "https://generativelanguage.googleapis.com"]
  ← БЕЗ http://localhost:3000 (був у старому без потреби)
entrypoints: один panel, icons/openai.svg
```

---

## Стиль

- Комментарі **українською**, по суті: чому так, а не що робить рядок.
- Без нових залежностей. Тільки `photoshop` і `uxp`.
- `node --check` мусить проходити на кожному файлі.
- Не копіювати старий код без потреби — половина його мертва.
