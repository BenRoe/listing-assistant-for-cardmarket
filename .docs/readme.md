# Findings index

Research notes for the Cardmarket listing plugin (ManaBox CSV -> Cardmarket "List Mixed Products" modal).
One file per topic. All findings were verified on the live site on 2026-10-16 unless marked "unverified".

| File | Topic |
| --- | --- |
| [listing-methods.md](listing-methods.md) | Which listing methods Cardmarket offers (no CSV upload exists) |
| [mixed-products-modal.md](mixed-products-modal.md) | The `Stock_ListProductModal` popup and the sell form fields (popup no longer used by the plugin) |
| [submit-test.md](submit-test.md) | Recorded results of the two real test submissions (popup and product page): request, response, UI changes, success signal |
| [product-page-filters.md](product-page-filters.md) | Product page: URL filters, saved default filter behaviour, sell form, offers markup |
| [id-mapping.md](id-mapping.md) | ManaBox Scryfall ID -> Cardmarket `idProduct` via Scryfall `cardmarket_id` |
| [manabox-csv.md](manabox-csv.md) | ManaBox list and collection CSV columns and values |
| [field-mappings.md](field-mappings.md) | Condition and language ID tables, ManaBox value -> Cardmarket value |
| [price-sources.md](price-sources.md) | Price fill: median/lowest of the filtered offers |
| [bulk-listing-limits.md](bulk-listing-limits.md) | Bulk listing page: GET filter, 300-card cap, rarity IDs, hidden `idProduct` inputs |
| [prior-art.md](prior-art.md) | `cardmarket-bulk-import`, `MtgCsvHelper`, `cardmarket-helper`: what they do and what is reusable |
| [playwright-setup.md](playwright-setup.md) | How the live-site tests were run (headed Chromium, persistent profile, cleanup) |
| [design.md](design.md) | Plugin design: data flow, storage, settings, open risks |
| [testing.md](testing.md) | What was tested (unit tests, live Chromium run) and what was not |
