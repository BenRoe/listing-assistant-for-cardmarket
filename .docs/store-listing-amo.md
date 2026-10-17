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
- Dark mode that follows Cardmarket's own theme.

## Privacy

- No telemetry, analytics, tracking or accounts.
- The only external request goes to `api.scryfall.com` and contains the Scryfall IDs of your CSV cards, to look up Cardmarket product IDs. Prices, quantities, file names and Cardmarket account data are never sent.
- CSVs, settings and listed flags stay in your browser's local extension storage.

[Privacy policy](https://github.com/BenRoe/listing-assistant-for-cardmarket/blob/main/PRIVACY.md) · [Source code (MIT)](https://github.com/BenRoe/listing-assistant-for-cardmarket)

Not affiliated with, endorsed by or sponsored by Cardmarket, ManaBox or Scryfall. All names are trademarks of their owners.
```

## Other fields

- Category: Shopping
- License: MIT
- Support site: https://github.com/BenRoe/listing-assistant-for-cardmarket
- Notes to reviewer: No build step. The zip is the repository contents. `lib/papaparse.min.js` is Papa Parse v5.0.2, unmodified. A Cardmarket account is needed to see the sell form.
