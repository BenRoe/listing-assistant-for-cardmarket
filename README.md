# Cardmarket Listing Assistant

Browser extension (Manifest V3, plain JavaScript, Firefox and Chromium) that helps to list cards from a ManaBox CSV on Cardmarket, one card at a time.

1. Load one or more ManaBox CSV exports (list or collection) in the panel under the top search bar of any Cardmarket Magic page.
2. Click **Search** on a card. The plugin opens its product page, filtered to the card's language, condition (as minimum) and foil state; your other saved Cardmarket filters stay as they are.
3. The plugin fills the Sell tab (quantity, language, condition, foil, signed, altered, comment) and a price, by default the median of the offers shown for that filter.
4. You check the offers and press "Put for sale" yourself. The plugin never submits anything.
5. The row is marked as listed when Cardmarket confirms the listing. Every loaded CSV keeps its own listed flags.

Cards are identified by the Scryfall ID in the ManaBox CSV, which Scryfall maps to the Cardmarket product ID, so there is no name matching.

## Install for development

- Chromium: `chrome://extensions`, enable developer mode, "Load unpacked", pick this folder.
- Firefox: `about:debugging`, "This Firefox", "Load Temporary Add-on", pick `manifest.json`.

Tests: `node --test test/shared.test.mjs`.

## Comparison with other tools

| | This plugin | [cardmarket-bulk-import](https://github.com/PedroPerpetua/cardmarket-bulk-import) | [cardmarket-helper](https://github.com/SuppenNudel/cardmarket-helper) | [MtgCsvHelper](https://github.com/StepKie/MtgCsvHelper) |
| --- | --- | --- | --- | --- |
| Kind | Browser extension | Browser extension | Firefox extension | Web app / console converter |
| Purpose | List cards one by one from a ManaBox CSV with the sell form pre-filled | Fill Cardmarket's "Bulk List Cards" table from a CSV | Many helpers for Cardmarket (thumbnails, owned printings, sell-form fill from a stored ManaBox collection, wants/orders export, ...) | Convert collection CSVs between sites |
| Cardmarket page | Magic product pages (Sell tab), panel on every Magic page | `Stock/ListingMethods/BulkListing` | Product, offer, order and wants pages | none |
| Card matching | Scryfall ID -> Cardmarket product ID (exact) | Card name (fuzzy) and set via MTGJSON | Scryfall ID / Cardmarket ID | Scryfall ID, names, set codes |
| Price | Median or lowest of the offers matching the card's language/condition/foil filter; multiplier, rounding, minimum | From the CSV price column | Price logic over low, trend and average prices plus top offers | Not applicable |
| Volume | One card per click, you review each | Up to 100 cards per import, Cardmarket shows at most 300 cards per filter | One card per click | Whole files |
| Listed tracking | Per loaded CSV, set automatically after Cardmarket's confirmation | none | Uses ManaBox's "misprint" field as a manual marker | none |
| Multiple CSVs | Yes, separate, with overwrite prompt | One file per import | One stored collection | Not applicable |
| Submits for you | Never | No (you submit the filled form) | No | Not applicable |

Notes:

- cardmarket-bulk-import is faster when you list many cards of one expansion in a single batch. It matches by name, only sees the cards on the current page of the bulk table, and imports nothing for cards beyond the 300-card cap (for example high collector numbers such as lands).
- cardmarket-helper covers far more than listing; this plugin is intentionally small and separate. The helper's "Fill" works on the Singles page from a collection stored in the browser.
- MtgCsvHelper cannot produce anything Cardmarket accepts: its Cardmarket format is import only, and Cardmarket has no CSV upload for listings.
- The comparison reflects the READMEs and code of the other tools as read on 2026-10-16; check them for newer changes.

## Documentation

Research notes and design are in [.docs/readme.md](.docs/readme.md).
