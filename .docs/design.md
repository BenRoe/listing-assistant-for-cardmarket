# Plugin design

Goal: pick a card from the ManaBox CSV, open Cardmarket's product page filtered to that card's language, condition and foil state, fill the Sell tab form, and let the user review the offers and press "Put for sale". The plugin never submits anything itself.

## Flow

1. Content script runs on `https://www.cardmarket.com/*/Magic/*`. The panel is the first child of `main.container`, directly under the top search bar, with a collapse toggle (state stored).
2. User picks one or more ManaBox CSVs (list or collection export), parsed with Papa Parse, see [manabox-csv.md](manabox-csv.md). Every file is kept and handled separately, including its listed flags (row keys start with the file name): a file selector appears when two or more are loaded, and loading a file whose name is already loaded asks whether to overwrite it (rows replaced, listed flags kept) or keep a separate copy (own id, own flags, shown as `name (load time)`). A collection export shows a binder selector (default: first binder) because the same card can sit in several binders.
3. Missing Scryfall IDs are resolved in batches of 75 through the background script (`POST /cards/collection`), see [id-mapping.md](id-mapping.md). Result cached.
4. Click **Search** on a row: the plugin stores `active = { key, idProduct, filled: false }` and navigates to `/<lang>/Magic/Products?idProduct=<id>&language=..&minCondition=..&isFoil=Y|N`, see [product-page-filters.md](product-page-filters.md). Other filters come from the user's saved Cardmarket filter.
5. On the product page the plugin finds `#ListProductForm` for that `idProduct` and fills amount, language, condition, foil/signed/altered, comment and price (median of the shown offers by default, see [price-sources.md](price-sources.md)); `saveSettings` is unchecked, the Sell tab is opened, the price field is focused. Mapping in [field-mappings.md](field-mappings.md).
6. The user checks the offers in the sidebar/table and presses "Put for sale". The form is a full page POST; the next page shows a success alert and the new own row, which marks the CSV row as listed, see [submit-test.md](submit-test.md).
7. A manual "done" / "undo" button per row covers cases the automatic signal misses.

## Storage (`storage.local`)

| Key | Content |
| --- | --- |
| `csvs` | `id -> { id, fileName, label, loadedAt, rows[], binder }`; `id` is a load timestamp, every loaded CSV is kept separately (row keys start with the id, so listed flags are per loaded CSV) |
| `activeFile` | CSV file currently shown |
| `scryfall` | `scryfallId -> { idProduct, name, finishes, eur, eurFoil }` (`idProduct: null` when Scryfall has none) |
| `done` | `rowKey -> { articleId, at }` |
| `active` | the row currently being listed (`key`, `idProduct`, `filled`, `at`); expires after 10 minutes |
| `collapsed` | panel collapsed or not |
| `settings` | see below |

`sessionStorage` holds only one timestamp (`cmlp.submitAt`) set when the sell form is submitted.

Buttons: **Remove CSV** (removes the file currently shown together with its listed flags, after a confirmation; the ID cache stays). Overwriting a same-named file keeps its flags. No data leaves the browser except the Scryfall IDs sent to `api.scryfall.com`.

## Settings (options page)

- Price: median (default), lowest, or none of the offers shown for the filter.
- Multiplier in percent (default 100), rounding step (0,01 or 0,05), minimum price (default 0,02).
- Write "Misprint" into the comment when ManaBox flags it.
- Stay logged in (default off): while a tab is open and logged in (a `Logout` link is on the page), fetch `/<lang>/Magic` every 30 minutes. Cardmarket's `idUser` cookie expires 1 hour after the last request; a plain GET renews it (measured 2026-10-18: expiry slid on every 5 minute ping, session alive after 22 minutes). Skipped on the login page; no password is stored.
- Stored data: buttons "Clear listed flags" (removes `done`) and "Clear Cardmarket ID cache" (removes `scryfall`). CSV files are removed in the panel.

The options page opens in its own tab (`open_in_tab: true`), not as a dialog on the extensions page.

## Edition label page

- `labels/` is a static folder (page, `core.js`, `labels.js`, `csv-sets.js`, fonts in `lib/`). It is opened through the background message `openLabels`, which creates a tab with `labels/labels.html`.
- `core.js` is the pure dual-environment layer (Node tests and browser): layout, 1-bit bitmap, PNG and ZIP encoding. The canvas preview paints the same bitmap that the PNG contains, so preview equals export.
- The only extension-API call is one guarded read of the loaded CSV in `csv-sets.js` (`storage.local.get`); without it (hosted copy, ordinary page) the page falls back to the Scryfall set list and the `#sets=` fragment.
- Page storage (`localStorage`): `cmlp.labels.settings` (options) and `cmlp.labels.sets` (public set list with timestamp, 24 h).
- The only request is `GET https://api.scryfall.com/sets`. No new permissions (the host permission for `api.scryfall.com` exists already).
- Export is 1-bit PNG, 128 px high (24 mm tape), 180 dpi.

## Permissions

`storage`; host permission `https://api.scryfall.com/*` (background fetch). Content script on `https://www.cardmarket.com/*/Magic/*`.

## Open risks

- Cardmarket can rename ids, classes or the success alert; all selectors are in `SEL` at the top of `js/content.js`.
- A failed submit was not tested.
- Cloudflare blocks the automated test browser at first; tests need a manual login, see [playwright-setup.md](playwright-setup.md).
