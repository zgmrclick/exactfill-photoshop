# ExactFill for Photoshop

[Українська версія](README.uk.md)

Exact AI edits, placed exactly where you selected them.

ExactFill is a free, open-source Photoshop plugin that connects directly to
OpenAI and Google Gemini with your own API keys. Select an area, describe the
change, and get the result back as a precisely positioned Smart Object with a
Photoshop layer mask.

> No account, no ExactFill server, no credit packs. You pay the AI provider
> directly and can see estimated API costs inside the plugin.

## Why ExactFill

- Precise placement in the original selection, including odd and fractional bounds.
- Non-destructive Smart Object output and Photoshop-native layer masks.
- RGB, CMYK, Grayscale and Lab workflows; 8/16/32-bit documents stay unchanged.
- OpenAI GPT Image and Google Gemini image models in one panel.
- Edge blending, context control, references, transparent output and lossless input.
- OpenAI intermediate preview frames when the API and UXP runtime support streaming.
- Persistent cost statistics, recent history, presets and a local result cache.
- English and Ukrainian interface.

## Install

Download `ExactFill-1.2.0.zip` from [Releases](https://github.com/zgmrclick/exactfill-photoshop/releases),
extract it completely, and close Photoshop before copying the folder.

### Windows

Copy the entire `ExactFill` folder to the `Plug-ins` folder of your Photoshop,
for example:

```text
C:\Program Files\Adobe\Adobe Photoshop 2026\Plug-ins\ExactFill
```

### macOS

Copy the entire `ExactFill` folder to the `Plug-ins` folder of your Photoshop,
for example:

```text
/Applications/Adobe Photoshop 2026/Plug-ins/ExactFill
```

Start Photoshop and open **Plugins → ExactFill**. The final `ExactFill` folder
must contain `manifest.json` directly inside it. If you are upgrading from the
private **AI Image** build, replace its old `AiImagePS` folder instead of keeping
both copies.

The archive also contains the same instructions in English and Ukrainian.

## First use

1. Open a document and make a selection.
2. Choose OpenAI or Google Gemini and paste that provider's API key.
3. Describe what should change and select **Generate**.
4. Review the new Smart Object and adjust its layer mask if needed.

API keys are stored with Photoshop UXP `secureStorage`. The selected pixels,
prompt and optional references are sent directly from Photoshop to the provider
you selected. See [Privacy](PRIVACY.md) for details.

## Cost and model availability

ExactFill itself is free. OpenAI and Google may charge for API use according to
their own pricing. The plugin keeps a local request ledger and shows an estimated
USD cost whenever the API response provides enough usage information. Pricing
and model availability can change; the provider's bill is authoritative.

## Compatibility

- Adobe Photoshop 2024 or newer (`25.0+`).
- Windows and macOS use the same plugin files.
- A network connection and an API key for the selected provider are required.
- Final Windows behavior should be verified on a real Windows Photoshop setup.

## Reporting problems

Use **Report a bug** inside the panel or open a
[GitHub issue](https://github.com/zgmrclick/exactfill-photoshop/issues/new/choose).
The in-plugin form can include version, OS, provider, model and settings; it does
not include API keys, prompts, document names, paths, images or usage history.

See [Support](SUPPORT.md), [Security](SECURITY.md), and
[Contributing](CONTRIBUTING.md) before sharing sensitive details or submitting code.

## Support the project

A donation link will be added after the public launch. For now, a star, a useful
bug report, a short demo, or sharing ExactFill with another Photoshop user helps.

## Development

No package install is required. Run the Node.js test suite and build the universal
release archive with:

```bash
npm test
npm run build
```

The release script writes `dist/ExactFill-<version>.zip`. Development measurements
behind the placement algorithm are kept in [`verify/`](verify/README.md).

## License

[MIT](LICENSE) © 2026 Havryil Zahorodnii
