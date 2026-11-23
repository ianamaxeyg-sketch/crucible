# The Crucible

An AI debate arena. Pick any Claude model for each side and for the judges: three rounds, a blind three-judge panel, and a model list that updates itself as Anthropic releases new Claude models.

**Open: https://ianamaxeyg-sketch.github.io/crucible/**

Pick any Claude model for each debater and for the judges. The list loads live from Anthropic's Models API each
visit, so a model released today shows up today; a "Latest Opus/Sonnet/Haiku/Fable" pick moves to each new
release on its own. Requests are shaped from each model's reported capabilities (adaptive thinking, effort,
structured output, refusal fallbacks), so new models work without an update to this page.

You need an Anthropic API key (console.anthropic.com, API keys). Debates are billed to that key per token. The
key stays in your browser, on this device (or only in this tab if you untick Remember), and is sent only to
api.anthropic.com. The page runs no third-party code: React and the Anthropic SDK are served from this
repository (`vendor/`, sources and checksums in `vendor/SOURCES.json`), and its Content-Security-Policy allows
connections only to api.anthropic.com.

This repository holds only the built site. Licenses of the bundled libraries: `vendor/README.md`.
