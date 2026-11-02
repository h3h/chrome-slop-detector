# Chrome Web Store listing

Copy for the Chrome Web Store developer dashboard. Upload `slop-flag-<version>.zip` from
`npm run package`; images are in `store/`.

## Store listing tab

**Name:** Slop Flag

**Summary** (from the manifest, 132 characters max):
Flags YouTube videos and articles that were obviously written by an AI model.

**Category:** Tools

**Language:** English

**Description:**

Slop Flag puts a small banner on articles and YouTube videos whose text was obviously written by an AI model, so you can decide how much of your attention they deserve.

It is tuned to be rare and right. A missed AI article costs little; a false accusation against a human writer costs more, so Slop Flag only flags pages it scores at 90% or higher, and you can raise that threshold.

What it checks:
• Articles and blog posts: the main text, extracted the same way Firefox Reader View does.
• YouTube videos: the English transcript, or the title and description when there is none.
• Nothing else. Web apps, mail, documents, search results and feeds are skipped, and you can add any site to the never-check list.

How it decides:
• Jev (default): TypeSafe's Jev model judges the writing style against a list of AI writing tropes, such as em-dash "it's not X — it's Y" contrasts, punchy verdicts, hollow "highlighting its importance" tails and salesy second-person advice. Requires a TypeSafe API key.
• Heuristic (optional): an offline check for stock AI phrasing. Very conservative, and nothing leaves your device.

What you see:
• A banner on flagged pages, with the score.
• An "AI" badge on the toolbar icon.
• The score for any checked page in the popup, plus a "Check this page" button for manual mode.

Privacy: Slop Flag has no server, no analytics and no tracking. With Jev, the page text is sent to TypeSafe's API with your key; with the Heuristic, nothing is sent. Settings and results stay in your browser. Full policy: https://github.com/h3h/chrome-slop-detector/blob/main/PRIVACY.md

Treat flags as hints, not proof. No detector is perfect.

**Homepage URL:** https://github.com/h3h/chrome-slop-detector

**Support URL:** https://github.com/h3h/chrome-slop-detector/issues

**Images:**

| Slot | File | Size |
|---|---|---|
| Store icon | `src/icons/icon128.png` | 128×128 |
| Screenshot 1 | `store/screenshot-article.png` | 1280×800 |
| Screenshot 2 | `store/screenshot-popup.png` | 1280×800 |
| Screenshot 3 | `store/screenshot-options.png` | 1280×800 |
| Small promo tile | `store/promo-small.png` | 440×280 |

## Privacy practices tab

**Single purpose:**
Slop Flag estimates whether the text of the article or YouTube video you are viewing was written by an AI model and shows that estimate as a banner, a toolbar badge and a popup.

**Permission justifications:**

- `storage`: Saves the user's settings (provider, API key, threshold, mode, never-check list), a 30-day cache of scores so pages are not re-checked, and per-tab results for the popup and badge. All local; nothing is synced.
- Host permission `<all_urls>` and content scripts on `http://*/*` and `https://*/*`: In automatic mode the extension checks articles on any site as they load, so its content script must run on all sites to find and extract the main text. The background service worker also needs host access to send that text to the classifier endpoint, which the user can change in Options from the default `https://api.typesafe.ai`.
- Content script in the page's main world on `https://www.youtube.com/*`: Reads the YouTube player's caption track list and gets the caption token the player adds to its own caption requests, so the extension can fetch the video's transcript. It only reads player data and briefly toggles captions, then restores the user's caption setting.

**Remote code:** No, I am not using remote code. All JavaScript is bundled in the package.

**Data usage** (what to tick):

- **Website content:** collected. The extracted text of checked pages is sent to the classifier (TypeSafe's Jev API by default) to get the AI-writing estimate.
- Everything else (personally identifiable information, health, financial, authentication, personal communications, location, web history, user activity): not collected. The API key is the user's own credential for TypeSafe; it is stored locally and sent only to the endpoint the user configured. If a reviewer considers it "authentication information", tick that too.

**Certifications:** tick all three (no selling or transferring data to third parties outside the approved use cases, no use unrelated to the single purpose, no use for creditworthiness or lending).

**Privacy policy URL:** https://github.com/h3h/chrome-slop-detector/blob/main/PRIVACY.md

## Distribution tab

**Payments:** Free. **Visibility:** Public (or Unlisted for a soft launch). **Regions:** All.
