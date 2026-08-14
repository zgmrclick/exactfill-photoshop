# Changelog

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
