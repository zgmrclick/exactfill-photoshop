# Contributing

Bug reports, focused fixes, documentation improvements and compatibility results
from real Windows or macOS Photoshop installations are welcome.

## Development checks

No npm dependencies are required. Before submitting a change, run:

```bash
npm test
npm run build
git diff --check
```

Keep changes focused. Do not add analytics, a proxy server or dependencies without
first discussing the tradeoff in an issue. Never commit API keys or private images.

Placement and mask behavior should remain non-destructive and must not convert the
user's document mode or bit depth. If placement code changes, include an exact
residual test or a reproducible Photoshop verification result.
