# Firefox add-on (AMO) listing text

Paste the blocks below into the AMO submit form. The description field supports Markdown; the first 250 characters carry the key points.

## Summary (max 250 characters)

```
Pick cards from your ManaBox CSV and get Cardmarket's sell form filled in: quantity, language, condition, foil and a price from the live offers. You review and submit every listing yourself. No tracking, no extra accounts.
```

## Description

```markdown
List Magic cards from your ManaBox CSV on Cardmarket, one at a time: click "Search" and the sell form is pre-filled with language, condition, foil and a price from the live offers. You review and submit each listing yourself. No tracking.

## How it works

- Load one or more ManaBox CSV exports (list or collection) in the panel under the search bar on any Cardmarket Magic page. Drag and drop works too.
- Click **Search** on a card. The extension opens its product page, filtered to the card's language, minimum condition and foil state. Your other saved Cardmarket filters stay as they are.
- The Sell tab is pre-filled: quantity, language, condition, foil, signed, altered, comment and a price.
- You check the offers and press "Put for sale" yourself. The extension never submits anything.
- When Cardmarket confirms the listing, the row is marked as listed. Every loaded CSV keeps its own listed flags.

## Features

- Exact card match through the Scryfall ID in the CSV, no name guessing.
- Price from the live market: median or lowest of the offers shown for the card's filter. Multiplier, rounding and minimum price are configurable.
- Click an offer price to copy it into the sell form.
- Filter changes keep your form values. Changing condition or language in the sell form updates the offers filter.
- Sortable and filterable card table, binder selector for collection exports.
- Optional "Stay logged in" (off by default): an open Cardmarket tab loads one page every 30 minutes, so the 1 hour idle logout does not hit. No password is stored.
- Dark mode that follows Cardmarket's own theme.
- **Edition labels**: a page to design storage-box labels with the set icon, name, code, foil mark and condition, with an exact preview and PNG or ZIP export for 24 mm label tape. On Chromium browsers it can also print straight to a Brother PT-P710BT over USB (24 mm tape check, copies, cut switch).

## Privacy

- No telemetry, analytics, tracking or accounts.
- The only external requests go to `api.scryfall.com`: the Scryfall IDs of your CSV cards, to look up Cardmarket product IDs, and, when you open the Edition labels page, one `GET /sets` for the public set list (cached 24 hours, no data sent). Prices, quantities, file names and Cardmarket account data are never sent.
- With "Stay logged in" on, the open Cardmarket tab also requests one Cardmarket page every 30 minutes.
- CSVs, settings and listed flags stay in your browser's local extension storage.
- Direct print is optional: after you press Connect the browser asks for permission to use your Brother printer over USB; the label bitmap goes only to that printer, nothing goes to a server. The page stores only the last transport and your cut and copies preferences in `localStorage`.
- The label page keeps its preferences and the cached set list in its own `localStorage` (no CSV data). Set codes in the `#sets=` URL fragment are never sent anywhere. PNG and ZIP files are made in the page and never uploaded.

[Privacy policy](https://github.com/BenRoe/listing-assistant-for-cardmarket/blob/main/PRIVACY.md) · [Source code (MIT)](https://github.com/BenRoe/listing-assistant-for-cardmarket)

Not affiliated with, endorsed by or sponsored by Cardmarket, ManaBox or Scryfall. All names are trademarks of their owners.
```

## Other fields

- Category: Shopping
- License: MIT
- Support site: https://github.com/BenRoe/listing-assistant-for-cardmarket
- Notes to reviewer: No build step. The zip is the repository contents. `lib/papaparse.min.js` is Papa Parse v5.0.2, unmodified. A Cardmarket account is needed to see the sell form. The zip also contains `labels/` (static page, no remote code). Third-party files: `labels/lib/keyrune/keyrune.woff2` (Keyrune 3.19.0, OFL-1.1 font, GPL-3.0 glyphs, licence text included) and `labels/lib/cinzel/cinzel-bold-latin.woff2` (Cinzel Bold subset, OFL-1.1, licence included). No new permissions. Direct print uses WebUSB from the extension page only after a user click and the browser's own device chooser; no manifest permission is added and the print code makes no network request. WebUSB does not exist in Firefox, so the USB button is disabled there with a reason. `tools/` is not shipped.
