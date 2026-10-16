# Prior art

## cardmarket-bulk-import (PedroPerpetua)

- Repo: https://github.com/PedroPerpetua/cardmarket-bulk-import (WXT + React + TypeScript).
- Works only on the **Bulk List Cards** page. Injects an "Import CSV..." button after `div#BulkAccordion` (visible only after an expansion is selected).
- Column mapping is fuzzy-matched from the CSV header names; ManaBox headers map correctly (Name, Set code, Foil, Signed, Condition, Language, Quantity). `Purchase price` is mapped to price (a buy price, wrong for selling).
- Matches cards by **name** (Fuse.js, strict) among the rows currently in the page table, and checks the set via MTGJSON `sets.csv` (`mcmId`) against `idExpansion` in the URL.
- Limits: 100 cards per import, only cards on the current page, the 300-card cap of the page (see [bulk-listing-limits.md](bulk-listing-limits.md)).
- No LICENSE file in the repository (GitHub license API returns 404). Do not copy code; reimplementing ideas is fine.

## MtgCsvHelper (StepKie)

- https://github.com/StepKie/MtgCsvHelper, .NET/Blazor WebAssembly converter between collection sites.
- Ships a Scryfall reference bundle (about 10 MB gzipped) whose `ReferenceCard` includes `CardmarketId`.
- Cardmarket support is **import only** (it reads Cardmarket exports); it cannot produce a file Cardmarket accepts, and Cardmarket has no upload for listings anyway.
- Not needed here: the Scryfall API returns `cardmarket_id` directly, see [id-mapping.md](id-mapping.md).

## cardmarket-helper (the user's own extension)

- Stores the ManaBox collection (`collection` keyed by Scryfall ID) in `storage.local` and syncs it through Google Drive.
- Already has Scryfall lookups, price guide download (`downloads.s3.cardmarket.com`), pricing logic in `sell.js` and ID/condition/language maps in `cardmarket-util.js`.
- Its content script `upload-csv.js` adds the file input on every `/Magic/*` page; it only stores the CSV.
- Condition and language maps in [field-mappings.md](field-mappings.md) are consistent with its `CONDITION_MAP_ID` and `LANG_MAP`.
- Bundled `papaparse.min.js` v5.0.2 (MIT) is reused in this plugin.
