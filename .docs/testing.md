# Testing

## Unit tests

`node --test test/shared.test.mjs test/labels.test.mjs test/labels-static.test.mjs` (Node 24, no dependencies). Covers:

- `test/shared.test.mjs`: `js/shared.js`, CSV row building for list and collection exports (binders, unique row keys), price parsing/formatting, price panel order, price computation (source, foil rule, multiplier, minimum, none).
- `test/labels.test.mjs`: `labels/core.js`, label layout, 1-bit bitmap and PNG encoding, ZIP, set filter/sort/search, validators.
- `test/labels-static.test.mjs`: static checks of `labels/` (no extension API except the single storage read, one allowed request, font files and licences present).

Smoke test of the label page: `PLAYWRIGHT_CORE=<path to playwright-core> node tools/smoke-labels.mjs` (headless Chromium over HTTP, needs the Playwright browser build; not run in CI).

Status 2026-10-16: 5/5 passing (`shared.test.mjs`). Smoke test of the label page: passed 2026-10-20 (plan 01-04, picker, designer, csv and offline scenarios).

## Live run in Chromium (unpacked extension, logged-in session)

Setup in [playwright-setup.md](playwright-setup.md). Results after the Search-flow change:

| Check | Result |
| --- | --- |
| Panel sits as first child of `main.container`, directly under the search bar; collapse toggle | ok |
| Background script (both `service_worker` and `scripts` keys in the manifest) | ok in Chromium; Firefox not tried |
| Load `ManaBox_Collection.csv` / `ManaBox_List.csv` through the panel | ok; binder selector for the collection export |
| Scryfall batch lookup through the background script | ok |
| Search on Irrigation Ditch (played, German, normal) | URL `...Irrigation-Ditch?sellerCountry=7&sellerReputation=3&language=3&minCondition=6&isFoil=N` (saved filter plus the three overrides) |
| Sell form fill on the product page | `amount=1`, `idLanguage=3`, `idCondition=6`, `isFoil=false`, price `0,10` = median of 50 offers, `saveSettings` unchecked, price field focused |
| Real submit (test 2) | full page POST, success alert and new `stockRow` as documented in [submit-test.md](submit-test.md) |
| Listed detection | simulated alert plus `stockRow` and the timestamp marker marked the row listed; "undo" reset it |

## Not tested

- Listed detection on a real submit through the finished plugin code (the signals were recorded in test 2; the plugin code was added afterwards and exercised with simulated signals).
- Firefox (temporary add-on via `about:debugging`).
- Rows without `cardmarket_id`, signed/altered flags, etched foil, products that offer only some languages, zero matching offers.
- Failed submissions.
- Edition labels: Firefox canvas and download, P-touch Editor on macOS, a real print on the PT-P710BT.
