# Slop Flag

A Chrome (Manifest V3) extension that flags YouTube videos, blog posts and news articles whose
text was **obviously** written by an AI model. It is tuned for precision: a flag should be rare.
A missed AI article costs little; a false accusation against a human writer costs more.

- **YouTube watch pages:** the English transcript if one is available, otherwise title +
  description. Auto-generated captions need a score 5 points higher to be flagged.
- **Articles:** pages that Mozilla Readability thinks are readable; the extracted title + body.
- **Everything else** (web apps, mail, search results, feeds, non-English pages) is skipped.

Text is classified by a pluggable provider: **Jev** (TypeSafe, hosted, needs an API key; the
default) or **Heuristic** (offline stock-phrase and structure checks, opt-in). The Heuristic
flags only at a score of at least 0.95, which requires all five of its tell categories to fire
(it ignores a lower threshold setting). A page is flagged
when the AI probability is at or above the threshold (default 0.90). Flagged pages get a banner
("Likely AI-written — Jev 96%") and a red **AI** badge on the toolbar icon. The popup shows the
score for every checked page.

## Build and load

Requires Node 22.

```sh
npm install
npm run build          # writes dist/
```

To build somewhere else: `node scripts/build.mjs --out <dir>` (or set `SLOP_OUT=<dir>`).

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick
the `dist/` folder. Rebuild and press the reload icon on the extension card after changes.

## Adding a Jev key

1. Right-click the toolbar icon → **Options** (or popup → **Settings**).
2. Read the notice at the top, paste your key into **Jev API key**, and click **Save**.
3. Click **Test provider** to send a fixed sample paragraph and see the raw response.

Without a key the popup shows "Unknown — Add an API key in Settings" and nothing is sent.

### The Jev API contract is unverified

The request and response shape in `src/providers/jev.js` comes from third-party write-ups; no
primary documentation could be reached when this was built. If requests fail with
"Unexpected response from provider" or "API key rejected":

- All request field names are constants in `JEV_FIELDS` at the top of `src/providers/jev.js`;
  `buildRequest()` assembles the body from them.
- The question's option names are `OPTIONS` (`ai_generated`, `human_written`, `unclear`); the
  probability used as the AI score is the one for `AI_OPTION` (`ai_generated`).
- Responses are read by `parseResponse()`. It accepts per-option probabilities as an object or
  an array, at the top level or under the first question's result; anything else fails closed.
- The `Authorization: Bearer <key>` header is set in `classify()`, in the `fetch` call's
  `headers`.
- The endpoint (default `https://api.typesafe.ai/v1/systemone`) and model (default
  `jev-1.13.0`) are editable in Options.

Jev is a general-purpose classifier, not a trained AI-text detector. Its accuracy for this task
is unverified. Treat flags as hints, not proof.

## Privacy

- Page text is sent to Jev only when a Jev key is set, the page passes the gates, and the host
  isn't on the never-check list. Heuristic runs locally and sends nothing.
- **Auto** mode (default) checks qualifying pages when they load. **Manual** mode checks only
  when you press **Check this page** in the popup.
- The never-check list ships with mail, docs, chat and intranet hosts (Gmail, Outlook, Google
  Docs/Drive, Notion, Atlassian, Slack, SharePoint, localhost, private IP ranges, `.local`,
  `.internal`). Hosts match by suffix. Add the current site from the popup with
  **Never check this site**.
- At most 2,500 words per page are sent. Results are cached locally for 30 days by a hash of
  the text, so revisiting a page doesn't send it again. At most 30 provider calls per hour.
- The API key is stored in `chrome.storage.local` on this device only, sent only to the
  configured endpoint, never logged, and never shown in the popup. The endpoint must be
  `https://` (plain `http://` is allowed only for `localhost` / `127.0.0.1`).
- No telemetry, no accounts, no sync.

## Detectors make mistakes

Detectors produce false positives, especially on non-native English writers, formulaic news
(wire stories, earnings reports) and heavily edited text. Vendor accuracy claims are
self-reported.

## Tests

Run test files individually; there is no need to run the whole suite.

```sh
# unit tests (vitest + jsdom), one or more files at a time
npx vitest run test/unit/policy.test.js
npx vitest run test/unit/build.test.js test/unit/popup.test.js test/unit/options.test.js

# end-to-end tests (Playwright, headless Chromium with the built extension)
npm run build
npx playwright test test/e2e/article.spec.js
```

Tests never call real provider APIs; end-to-end tests point the Jev adapter at a local mock
server.

## Layout

```
src/manifest.json
src/background/   service worker: routing, cache, rate limit, provider dispatch, badge
src/content/      isolated-world content script (gates, extraction, banner) and the
                  MAIN-world YouTube bridge (yt-main.js)
src/providers/    jev.js, heuristic.js
src/lib/          pure helpers (text, hash, policy, settings, cache, deny list, YouTube)
src/popup/, src/options/
scripts/build.mjs esbuild bundle into dist/ (regenerates icons if they are missing)
```
