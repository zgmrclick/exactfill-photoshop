# Changelog

## 1.5.0 — 2026-09-09

- **Added GPT Image 2.5** in both variants: `gpt-image-2.5-sunburst` (base model, best quality) and
  `gpt-image-2.5-flare` (small model, fastest and cheapest of the family). Both accept arbitrary
  output resolutions, so the plugin keeps asking for the exact proportions of your selection. The
  model picker explains which is which on hover; existing installs keep the model they already use.
- **The model picker no longer hides models based on the `/v1/models` catalogue.** That catalogue
  lists what OpenAI chose to enumerate, not what a key is allowed to call: measured on 2026-09-09,
  both 2.5 variants generate images on a key whose catalogue does not list them. Filtering by it
  would have hidden models that work. When a model genuinely is not open to your account, the
  request now fails with a sentence that says so, instead of a bare `HTTP 404`.
- **Added the X-high and Max effort levels** that 2.5 introduces. They do not request more pixels —
  `High` already reaches the model's ceiling — they buy more rendering effort at the same
  resolution, and you pay for that in output tokens. The plan card therefore shows the same
  megapixels for High, X-high and Max, which is the truth rather than a rounding error.
- **Quality levels now belong to the model, not to the panel.** Only 2.5 accepts X-high and Max;
  sending them to GPT Image 1 is an HTTP 400 instead of a picture. Switching to a model that lacks
  the level you picked steps *down* to the nearest one it does accept — never up, so a model switch
  can never silently raise your bill — and your preference returns as soon as it is available again.
- **A prompt longer than about 256 characters silently stopped accepting new text.** This was never
  a limit anyone set: a Photoshop UXP text field applies an undocumented default unless the markup
  declares one, and prompts were being quietly cut short with no error, no truncated tail and no
  event. Every text field in the panel — prompt, bug report, prompt presets and the API key box —
  now declares an explicit limit, and the prompt shows a character counter once it nears that limit
  so the ceiling can never be invisible again. A regression test fails the build if any field is
  added without one.
- **The "Lossless input" checkbox now always holds.** Above 2 MP it used to quietly fall back to
  JPEG — but only when no mask was being sent, so the very same checkbox worked or not depending on
  an unrelated setting (the context percentage). The 2 MP threshold only ever applied to the
  plugin's own PNG encoder; above it Photoshop writes the PNG itself, which it could do all along.
- **The plan card now names the request that will actually be sent.** With a context percentage
  above 0 the plugin has to send PNG, because OpenAI requires the input and the mask to share a
  format — but the card read only the "Lossless input" checkbox and promised JPEG. Measured in
  Photoshop on 2026-09-09: the card said 58 KB JPEG while 1227 KB of PNG went out. The card now
  also says "with mask", because a mask changes what the model does — it regenerates the masked
  area rather than editing what is already there — and that is worth knowing before you pay for it.
- **"Regenerate" now honours a changed context percentage.** It reused the stored context frame
  along with the area, so moving the slider before pressing it changed nothing: same frame, same
  price, no hint anywhere in the panel.
- `input_fidelity` is now decided by the model's declared capabilities instead of a hard-coded name
  check, so a future model cannot inherit a parameter it does not accept.
- The plan card warns when a request exceeds 2560×1440, which OpenAI documents as experimental —
  that is also the most expensive thing the panel can ask for.
- Prices verified 2026-09-09; GPT Image 2.5 is billed at the same rate as GPT Image 2. A new test
  fails the build if a model is added to the picker without a matching entry in the price table.
- Removed `rows` from every textarea: UXP ignores it (documented known issue) and the height has
  always come from CSS, so the attribute only misled whoever read the markup next.


## 1.4.0 — 2026-08-14

- Added a network route option: when a firewall blocks Photoshop itself, requests can be made by the
  system `curl` tool instead, which is a separate program and therefore not covered by a rule that
  blocks Photoshop. `curl` ships with macOS and with Windows 10 and newer, so nothing is installed.
- Auto mode decides the route with one short keyless preflight instead of waiting out the request
  timeout: a firewall-blocked connection hangs rather than failing, so the old behaviour would have
  shown "Generating…" for up to five minutes before trying anything else.
- The API key is never passed on the command line — it lives only in a `curl --config` file, so it
  does not appear in the process list. Live preview is preserved: the response file is polled while
  `curl` is still writing it.
- Fixed a silent mask failure: OpenAI requires the input image and the mask to share the same
  format, but above 2 MP the plugin quietly captured JPEG while still sending a PNG mask. The
  server accepts that combination and ignores the mask, so the model repainted the whole frame
  instead of the selection — which looked like the selected area never reached the model, and
  looked random because the trigger was the selection size, not a setting. When a mask is sent
  the input is now always PNG, written by Photoshop itself for large areas; the mask is RGBA;
  and a mismatched pair drops the mask with an explicit log line instead of failing silently.
- Verified on macOS with Photoshop actually blocked (Gemini model list and a full OpenAI generation
  both completed through curl). The Windows route is not verified yet; Auto falls back to the direct
  request whenever the curl route is unavailable, including when the plugin work path is not ASCII.

## 1.3.2 — 2026-08-12

- Added direct Ko-fi support links to the Photoshop panel, project website, README files and GitHub Sponsor button.

## 1.3.1 — 2026-08-12

- Added theme-aware 23 px and 46 px PNG panel icons so minimized Photoshop toolbars show the ExactFill mark instead of the generic fallback.
- Removed the non-functional Cmd/Ctrl+Enter prompt shortcut and its misleading UI hint.

## 1.3.0 — 2026-08-12

- Added a dedicated vertical scroll region that keeps the ExactFill header visible.
- Redesigned the primary workflow for clearer prompt, provider, model, quality and action hierarchy.
- Improved narrow-panel behavior down to the 230 px manifest minimum without horizontal overflow.
- Added keyboard-accessible accordions, explicit focus states and accessible busy/selection state metadata.
- Increased the preferred docked and floating panel sizes while preserving the existing minimum size.
- Replaced fragile grid-dependent layout and oversized Spectrum actions with deterministic UXP-safe controls.
- Added a readiness card, compact bordered accordion stack, consistent inline icons and collapsed-by-default advanced settings.
- Added an optimized real-world demo video, release screenshots and an interactive before/after page.

## 1.2.1 — 2026-08-11

- Added bilingual firewall and proxy guidance for Windows and macOS.
- Network errors now identify the blocked API host and required outbound HTTPS access.
- Documented the Windows Firewall rule-precedence limitation for explicit Block rules.

## 1.2.0 — 2026-08-11

- Public release under the ExactFill name.
- Added English and Ukrainian interface localization.
- Added in-panel privacy information and a safe GitHub bug-report form.
- Added persistent API cost statistics and recent request history.
- Improved selection masks and adjustable edge blending.
- Added OpenAI intermediate preview frames with a non-streaming fallback.
- Added one universal manual-install package for Windows and macOS.

## 1.1.0

- Added references, presets, result cache, cancellation and regeneration.
- Added OpenAI and Gemini providers in one panel.

## 1.0.0

- Initial precise Smart Object placement workflow.
