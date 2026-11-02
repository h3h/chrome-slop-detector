# Slop Flag privacy policy

Last updated: November 1, 2026

Slop Flag is a Chrome extension that estimates whether the text of an article or YouTube video
was written by an AI model. This policy describes what it reads, where that goes, and what it
keeps.

## What Slop Flag reads

On pages it checks, Slop Flag reads the main text of the page:

- **Articles:** the title and body text that Mozilla Readability extracts from pages that look
  like articles. Other pages (web apps, mail, search results, feeds) are skipped.
- **YouTube watch pages:** the video's English transcript, or its title and description when no
  transcript is available. To get the transcript, Slop Flag requests YouTube's own caption file
  from youtube.com in your browser. For some videos this means briefly turning on the player's
  English captions and then restoring your caption setting.

Slop Flag never reads pages on sites in its never-check list. The list starts with common mail,
document and workspace sites (Gmail, Outlook, Google Docs and Drive, Notion, Atlassian, Slack,
SharePoint) and local addresses, and you can add any site to it.

In automatic mode (the default), pages are checked as they load. In manual mode, a page is
checked only when you click "Check this page" in the popup.

## Where the text goes

- **Jev provider (default):** the extracted text, up to 2,500 words, is sent with your API key to
  TypeSafe's Jev API (`https://api.typesafe.ai/v1/systemone`), or to another endpoint you enter
  in Options. TypeSafe returns a probability and Slop Flag shows it to you. TypeSafe's handling
  of that request is covered by TypeSafe's own terms and privacy policy.
- **Heuristic provider (opt-in):** text is analyzed entirely on your device and is not sent
  anywhere.

Slop Flag sends nothing else: no page URLs to its developer, no analytics, no tracking, no ads.
It has no server of its own.

## What Slop Flag stores

Everything is stored locally in your browser with Chrome's extension storage, and nothing is
synced to your Google account:

- **Settings:** provider, API key, endpoint, model, threshold, mode and never-check list.
- **Results cache:** for up to 30 days, the score and the provider's short response, keyed by a
  hash of the text. Page text and URLs are not stored in the cache.
- **Rate limit log:** timestamps of recent provider requests (at most 30 per hour).
- **Per-tab state:** each open tab's URL and result, kept only for the browser session.

Uninstalling the extension deletes all of it.

## Sharing and use

Slop Flag does not sell or transfer user data to anyone, does not use it for any purpose other
than showing you the AI-writing estimate, and does not use it to determine creditworthiness or
for lending. The use of information received from Chrome APIs complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Contact

Questions or concerns: open an issue at
<https://github.com/h3h/chrome-slop-detector/issues>.
