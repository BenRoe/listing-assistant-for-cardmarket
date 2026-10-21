# Testing

## Unit tests

`node --test test/shared.test.mjs test/labels.test.mjs test/labels-static.test.mjs test/ptouch.test.mjs test/printer.test.mjs test/transport.test.mjs` (Node 24, no dependencies). Covers:

- `test/shared.test.mjs`: `js/shared.js`, CSV row building for list and collection exports (binders, unique row keys), price parsing/formatting, price panel order, price computation (source, foil rule, multiplier, minimum, none).
- `test/labels.test.mjs`: `labels/core.js`, label layout, 1-bit bitmap and PNG encoding, ZIP, set filter/sort/search, validators.
- `test/labels-static.test.mjs`: static checks of `labels/` (no extension API except the single storage read, one allowed request, font files and licences present).
- `test/ptouch.test.mjs`: golden bytes, framing, chain pages, status sentences.
- `test/printer.test.mjs`: print flow against a fake transport.
- `test/transport.test.mjs`: queue, USB and serial transports against fakes.

Smoke test of the label page: `PLAYWRIGHT_CORE=<path to playwright-core> node tools/smoke-labels.mjs` (headless Chromium over HTTP, needs the Playwright browser build; not run in CI). Print scenarios with stubbed devices: `usb-print`, `print-errors`, `print-batch`, `print-cut`, `print-lost`, `print-support`, `print-reconnect`. They were not re-run after the cut-off and chain changes of 2026-10-21.

Hardware results of direct print (2026-10-21): [docs/label-printing.md](../docs/label-printing.md).

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
- Direct print: HW-4 error sentences with a 12 mm cassette, no cassette and open cover (not run); 6 mm start margin with cut on after `LEAD_DOTS`; Bluetooth (deferred).
- Edition labels: Firefox 140+ (canvas, download), and the unrecorded EXP-04 measurements listed below.

## Edition labels hardware check (EXP-04)

Date 2026-10-20. Setup: Brave on a Mac, extension loaded unpacked; P-touch Editor (Mac), PT-P710BT (USB), 24 mm tape. EXP-04 was approved by the owner on this scope; it was not fully measured. Values not reported are marked "not recorded".

| Check | Result |
| --- | --- |
| Extension in Brave | works: loads, panel button opens the label page, downloads work |
| Editor import size | wrong by default: the editor ignores the 180 dpi tag and imports the PNG far too small (Width 18 mm x Height 3 mm, long side squeezed to the 18 mm print height). "Scale to Print Area" is not usable (needs Set Length enabled and an estimate) |
| Workaround that works | select the image, Fix Aspect Ratio on, type Height = 18 mm in the Layout panel; Width follows (about 100 mm for the test label); size then looks correct |
| Editor settings in the owner's screenshot | Margin 3 mm, Landscape, 24 mm tape, PT-P710BT(USB), X 3 mm, Y 3 mm, Set Length off |
| Print quality | looks sharp (an earlier blur was only in the editor preview) |
| Printed length vs page caption (mm) | not recorded |
| Printed artwork height (mm) | not recorded |
| Clipping at ends or edges | not recorded |
| Legibility of the small line and icon | not recorded beyond "print looks sharp" |
| Polarity (dark ink on light tape) | not recorded |
| Editor cut settings and feed margin seen | not recorded |
| Brave download prompt behaviour | not recorded |
| Firefox 140+ (preview renders, PNG download) | not tested |
| Licence decision | yes: ship the Keyrune woff2 inside the MIT extension with the licence text and README attribution |

Open problems:

- P-touch Editor ignores the PNG's 180 dpi tag and imports it too small. Workaround is documented in the README and on the label page (Height = 18 mm, Fix Aspect Ratio on). Not fixable in the PNG.
- Firefox 140+ is untested.
