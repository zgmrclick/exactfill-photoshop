# ExactFill privacy

Effective: 11 August 2026

ExactFill has no account system, analytics, telemetry or application server.

## Data stored locally

- API keys are stored by Adobe Photoshop UXP `secureStorage`.
- Settings, prompt presets, request history and estimated costs are stored in
  Photoshop's local plugin storage.
- Recent generated images may be kept in the local result cache until you clear
  it or ExactFill rotates old entries.

## Data sent to AI providers

When you generate an image, ExactFill sends the prompt, selected image pixels,
optional surrounding context and any reference images directly to the provider
you selected: OpenAI or Google. Their privacy policies and API data controls apply.

ExactFill does not send API keys, prompts, documents or images to its developer.
The plugin does not add hidden tracking requests.

## Bug reports

The optional in-plugin report form opens a GitHub issue that you review before
submitting. Its diagnostics can include ExactFill and Photoshop versions, OS,
interface locale, provider, model, quality and selected feature settings. It does
not include API keys, prompts, document names, file paths, images or usage history.

Do not paste API keys, confidential prompts or client artwork into a public issue.

Questions can be filed in the
[ExactFill issue tracker](https://github.com/zgmrclick/exactfill-photoshop/issues).
