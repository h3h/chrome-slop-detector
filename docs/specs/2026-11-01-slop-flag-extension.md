# Slop Flag — Chrome extension that flags obviously AI-written content

Status: approved for build (revised after review) · Date: 2026-11-01

## Goal

While browsing, flag YouTube videos, blog posts and news articles whose text was
**obviously** written by an AI model. "Obviously" is the product bar: a flag must be rare and
high-precision. A missed AI article costs little; a false accusation against a human writer
costs trust in the tool. Every choice below favors precision over recall.

## Non-goals (v1)

- Proving authorship; per-sentence highlighting.
- AI images, voices or video frames. YouTube is judged on its words only.
- YouTube Shorts (`/shorts/`).
- Pangram / GPTZero / other vendor adapters. The provider interface makes them a single file
  each later; their APIs could not be verified from the build environment.
- Web Store publishing, telemetry, accounts, cross-device sync.
- Classifying arbitrary pages (web apps, mail, docs, search results, feeds, non-English pages).

## Providers

```js
// providers/<name>.js — pure, fetch injected
classify({ text, kind, url, title }, { apiKey, endpoint, model, fetch, signal }) -> Promise<{
  aiProbability: number,   // 0..1
  provider: string, model?: string,
  raw?: object             // trimmed provider response, serialized ≤ 2 KB
}>
// throws ProviderError { code: 'auth' | 'rate_limit' | 'bad_response' | 'network' | 'timeout' }
```

1. **Jev (TypeSafe)** — default provider. Jev is a hosted non-generative classifier: you send
   text plus a closed question and it returns the chosen option and a probability per option.
   - Question: instructions "Was this text obviously written by an AI language model?"; choice
     criteria `ai_generated`, `human_written`, `unclear`, each with a one-line description.
     `aiProbability = p(ai_generated)` (unclear mass is not added).
   - **Unverified contract** (from third-party write-ups; no primary doc reachable):
     `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, default model
     `jev-1.13.0` (pinned; `jev-latest` floats). All request field names are constants at the
     top of `providers/jev.js`. Parser accepts per-option probabilities as an object
     (`{ai_generated: 0.9, ...}`) or an array (`[{option, probability}]`), found at the top level
     or under the first question's result; anything else → `bad_response`.
   - Endpoint and model are editable in Options. Endpoint must be `https://`; `http://` only
     for `localhost` / `127.0.0.1` (tests). The endpoint receives the API key.
   - Jev is a general classifier, not a trained AI-text detector. Options says so.
2. **Heuristic** — offline, no key. **Opt-in only** (selected explicitly in Options), never a
   silent fallback. ~10 stock phrases ("delve", "tapestry", "it's important to note",
   "in today's fast-paced world", "navigate the complexities", "a testament to", "in conclusion",
   "unlock the potential", "ever-evolving landscape", "embark on a journey") plus 3 structural
   signals (em-dash density per 100 words, "not just X, but Y" constructions, low
   sentence-length coefficient of variation). Each signal is a tell *category*. Score formula is
   defined in the plan and deterministic. Flags only when ≥ 3 distinct categories fire **and**
   score ≥ 0.95. UI labels it "heuristic".
3. **Mock** — test-only behaviour is just the Jev adapter pointed at a local HTTP server; no
   separate provider.

No provider configured (Jev selected, no key) → state `unknown` reason `no_provider`.

## What gets classified

| Page | Gate | Text sent |
|---|---|---|
| YouTube watch (`https://www.youtube.com/watch*`) | URL | English transcript if obtainable, else `title + "\n\n" + description` |
| Article / blog / news | `isProbablyReaderable(document)` then `Readability.parse(document.cloneNode(true))` | `title + "\n\n" + textContent` |
| Anything else | — | nothing, no state |

Global skips: non-http(s) schemes; top frame only; deny-listed host; `<html lang>` set and not
starting with `en`.

- `normalize(text)`: strip zero-width chars, collapse whitespace, trim. Words = count of `/\S+/g`.
- Minimum 250 words (transcripts 300); below → `unknown` reason `too_short`.
- Truncate to the first 2,500 words at a word boundary (hardcoded).
- **YouTube.** A MAIN-world script (manifest `"world": "MAIN"`, youtube only) answers requests
  from the isolated script over `window.postMessage`. Request `{__slop: NONCE, type:'get-player'}`;
  reply `{__slop: NONCE, type:'player', videoId, title, shortDescription, captionTracks}` where
  data comes from `document.getElementById('movie_player')?.getPlayerResponse?.()` with
  `window.ytInitialPlayerResponse` as fallback (it is stale after SPA navigation). Both sides check
  `event.source === window` and the nonce. Triggers: initial `document_idle` and every
  `yt-navigate-finish`, deduped by `videoId`; ignore replies whose `videoId` ≠ URL `v`.
- Caption track: `languageCode` starts with `en`; prefer `kind !== 'asr'`. Fetch
  `baseUrl + '&fmt=json3'`; text = `events[].segs[].utf8` joined with spaces. Any failure →
  description fallback; popup shows "transcript unavailable". ASR transcript → threshold +0.05.
  Expect most YouTube pages without transcripts to end `too_short`; that's correct behaviour.

## Flag policy

- Stored result has `aiProbability`, never a verdict. Verdict computed at display time:
  `flagged` if `aiProbability ≥ threshold (+0.05 if ASR)`, else `clear`. Default threshold 0.90.
- States: `flagged`, `clear`, `unknown` (reasons: `too_short`, `no_provider`, `auth`,
  `rate_limit`, `provider_rate_limit`, `bad_response`, `network`, `timeout`), `pending`.
- Banner appears only for `flagged`. Copy: "Likely AI-written — Jev 96%". The popup shows the
  number for every state plus a standing disclaimer: detectors produce false positives,
  especially on non-native English writers, formulaic news (wire stories, earnings reports) and
  heavily edited text.

## Privacy, cost, limits

- Page text goes to a provider only when a key is set, the page passes the gates, and the host
  is not deny-listed.
- Modes: **Auto** (classify qualifying pages on load) and **Manual** ("Check this page" button in
  the popup). Default Auto, presented with a notice on the same Options form where the key is
  first entered.
- Deny list: hostname suffix match, no globs. Defaults: `mail.google.com`, `outlook.live.com`,
  `outlook.office.com`, `docs.google.com`, `drive.google.com`, `notion.so`, `atlassian.net`,
  `slack.com`, `sharepoint.com`, `localhost`, `127.0.0.1`; plus hostname regex for RFC1918 IPs,
  `.local`, `.internal`. Popup has "Never check this site" (appends host).
  E2E tests serve fixtures on `127.0.0.1`; tests override the deny list in seeded settings.
- Cache: `chrome.storage.local` key `cache`, object keyed
  `provider|model|sha256(text actually sent)`, value `{aiProbability, raw, source, asr, ts}`.
  30-day TTL, cap 500, prune oldest on write. Errors are not cached.
- Rate limit: 30 provider calls per rolling hour, timestamps in `chrome.storage.local`; over →
  `unknown/rate_limit`, no queue. Per-tab in-flight dedupe best-effort in SW memory. Provider
  fetch timeout 20 s via `AbortController`.
- Per-tab latest result in `chrome.storage.session` keyed by tabId (SW may restart).
- API keys in `chrome.storage.local` only. Never logged. Banner/popup render with
  `textContent`, never `innerHTML`.

## Architecture (MV3)

```
src/content/main.js     isolated world, <all_urls>, document_idle, top frame: gates, extract,
                        message SW, render banner (open shadow root on <slop-flag-banner
                        data-state=...>, fixed top, dismissable)
src/content/yt-main.js  MAIN world, youtube only
src/background/sw.js    module SW: router, settings, cache, rate limit, provider dispatch,
                        badge (red "AI" flagged, "?" unknown-error, "" otherwise), session state
src/providers/{jev,heuristic}.js
src/lib/{text,hash,cache,policy,settings,denylist,youtube}.js   pure
src/popup/              plain DOM; resolves tab via ?tabId= param, else tabs.query active
src/options/            plain DOM; provider, key, endpoint, model, threshold, mode, deny list,
                        "Test" button (sends a fixed sample, shows raw response)
```

- esbuild bundles to `dist/` (content scripts IIFE; SW ESM). `npm run build`; load `dist/`.
- Permissions: `storage`, `tabs`; `host_permissions: ["<all_urls>"]` (content script + any
  endpoint). No `activeTab`, no optional permissions.
- Messages (content → SW): `{type:'classify', kind, text, title, url, asr, source, force?}` →
  response `{state, reason?, aiProbability?, threshold, provider, source}`. Popup →
  SW: `get-tab-state`, `check-tab` (Manual / Re-check with `force` bypassing cache, still rate
  limited), `deny-host`. SW → content: `run-check` (popup button).

## Testing

- **Unit (vitest, jsdom):** text normalize/count/truncate; deny list; policy thresholds incl. ASR
  bump; cache TTL/cap/key; rate limiter; settings defaults + endpoint validation; Readability gate
  on fixture HTML (article vs homepage vs app); YouTube track selection + json3 parsing + message
  protocol; Jev adapter (both response shapes, nested, 401/403/429/500, malformed, timeout);
  heuristic on synthetic AI/human paragraphs written for the tests; SW router with a hand-rolled
  `test/chrome-stub.js` (no `vitest-chrome`).
- **E2E (Playwright ≥1.49, `launchPersistentContext` with `channel:'chromium'`, headless,
  `--load-extension=dist`):** extension id from the service worker URL; settings seeded via
  `sw.evaluate(() => chrome.storage.local.set(...))`; local HTTP server for fixture pages and a
  mock Jev endpoint that records calls. YouTube fixture served by `page.route('https://www.youtube.com/**')`
  (routes don't intercept SW fetch — the mock provider must be the real local server). Popup
  opened as `chrome-extension://<id>/popup/index.html?tabId=N`. Badge via
  `sw.evaluate(() => chrome.action.getBadgeText({tabId}))`.
  Scenarios: flagged article shows banner + badge; low-probability article no banner; non-article
  zero calls; revisit served from cache (one call total); deny-listed host zero calls; Manual mode
  zero calls until popup button; YouTube fixture with transcript → flagged; one Options form
  save test.
- No live calls to real provider APIs.

## Known risks

- Jev API shape unverified; isolated adapter + editable endpoint/model + Test button.
- All detectors have false positives; vendor accuracy claims are self-reported.
- YouTube internals rot; fallback path required.
- Browsing text sent to a third party; opt-in by adding a key; deny list + gates.
