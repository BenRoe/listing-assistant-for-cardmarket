# Edition labels for storage boxes (Brother PT-P710BT)

Research and decisions for a new feature: print or export storage-box labels with the MTG edition icon, the edition name and optional extras. Research date: 2026-10-20. Nothing here is built or tested on a printer yet.

## Goal

A label for a storage box, for example the Onslaught box: set icon, set name, set code, and optionally foil and condition. Target printer: Brother P-touch CUBE Plus PT-P710BT, first with 24 mm TZe tape.

## Decisions

| Topic | Decision |
| --- | --- |
| Where | New extension page `labels/labels.html`, opened from a button in the panel (Option A). A button on Cardmarket expansion or product pages (Option B) comes later. |
| Hosting | Extension page, written as a static page: nothing in `labels/` may depend on `chrome.*` / `browser.*`, except one optional call that reads the sets of the loaded CSV from `storage.local`, with a fallback to set codes in the URL fragment (`labels.html#sets=ons,dom`). The same folder can then be deployed to a website later (decide in phase 2, after the Brave and Firefox tests). The fragment is never sent to a server, so `PRIVACY.md` stays true. |
| Phase 1 | Label design and export only: preview plus PNG download. No printer connection. |
| Phase 2 | Direct print over Bluetooth (Web Serial) and USB (WebUSB). |
| Tape | 24 mm first (128 dots at 180 dpi). Other widths later. |
| Test setup | Brave on the macOS host first, Firefox later. |
| Label content | The user picks what to show: icon, name, set code. No quantity. Optional foil mark and Cardmarket condition short code. |

## Can the printer be fed directly?

Yes. Brother publishes the raster command reference, and the byte stream is identical over USB bulk, Bluetooth SPP and TCP. Two ways to get a "ready to use" result:

1. **Image file.** A 1-bit PNG at 180 dpi, exactly as tall as the printable area of the tape. Import it into Brother P-touch Editor, `fjanicki/ptouch`, or a CLI such as `jantman/pt-p710bt-label-maker`.
2. **Raw job file (`.prn`).** The same bytes a driver would send. On Linux it can be written to `/dev/usb/lp0` (the `usblp` driver claims the printer). Plausible, not tested.

Direct print from the browser (phase 2):

- **Bluetooth.** The PT-P710BT uses Bluetooth Classic (SPP), not BLE, so Web Bluetooth does not work. Pair the printer in the OS, then use **Web Serial** (Chrome/Edge/Brave 117+; Firefox 151+ for serial ports, unverified in extension pages).
- **USB.** **WebUSB** (Chromium only), vendor `0x04f9`, product `0x20af`. No manifest permission needed.
- **Where the permission prompt lives.** `requestDevice()` / `requestPort()` need a user gesture and cannot run in the MV3 service worker or in a content script (it would bind the permission to cardmarket.com). Run them in an extension page, hence `labels/labels.html`.
- **Linux USB gotcha.** The kernel `usblp` driver claims the printer and Chromium cannot take it over. Start the browser with `--enable-features=AutomaticUsbDetach`, or blacklist `usblp` and add a udev rule for vendor `04f9`. Bluetooth avoids this. On macOS this does not apply.

## Existing code to reuse (do not write the protocol from scratch)

- [dtinth/p-touch-webusb](https://github.com/dtinth/p-touch-webusb), `brother-pt.js`: 434 lines of JS, Apache-2.0, tested on a PT-P710BT with 18 mm tape. WebUSB only. Phase 2 swaps its `write()`/`read()` for a Web Serial transport. It sends raw (uncompressed) lines, which is enough.
- [fjanicki/ptouch](https://github.com/fjanicki/ptouch): Rust/WASM library plus web studio (https://fjanicki.github.io/ptouch/), Apache-2.0/MIT, hardware-tested on the PT-P710BT over USB and Bluetooth. Its `docs/PROTOCOL.md` is the best protocol write-up found. Too big to embed; useful as a reference and as a fallback tool that imports the exported PNG.
- [jantman/pt-p710bt-label-maker](https://github.com/jantman/pt-p710bt-label-maker), [treideme/brother_pt](https://github.com/treideme/brother_pt): Python references.
- Brother, [Raster Command Reference PT-E550W/P750W/P710BT](https://download.brother.com/welcome/docp100064/cv_pte550wp750wp710bt_eng_raster_102.pdf).

## Print geometry (180 dpi, 128-pin head)

| Tape | Printable dots (height of the PNG) |
| --- | --- |
| 3.5 mm | 24 |
| 6 mm | 32 |
| 9 mm | 50 |
| 12 mm | 70 |
| 18 mm | 112 |
| 24 mm | 128 |

Label length is free, with a minimum of about 174 dots (25 mm) in dtinth's driver. The printer reports the loaded tape width in its status reply, so phase 2 can check it against the label.

## Keyrune (set icons)

- Repository: https://github.com/andrewgioia/keyrune, v3.19.0 (last commit 2026-05-02). Usage: `<i class="ss ss-ons">`, class names are MTGJSON set codes.
- Assets: `fonts/keyrune.woff2` (144 KB), 434 single SVGs in `svg/`, `css/keyrune.css` (code to glyph map).
- Plan: ship only the woff2 and render the glyph onto a canvas. The plugin does not need the SVGs.
- **Licence.** Font files: SIL OFL-1.1. Glyphs and SVGs: GPL-3.0. Code: GPL-3.0. The symbols are trademarks of Wizards of the Coast. The plugin is MIT. Ship the woff2 in its own folder (for example `lib/keyrune/`) together with the licence text, and mention it in the README.
- **Code mapping.** The plugin already stores `setCode` (upper case) and `setName` per ManaBox row (`js/shared.js`). ManaBox uses Scryfall set codes, lower-cased they match the Keyrune class names.
- **Coverage** (measured 2026-10-20 against `api.scryfall.com/sets`, paper sets): expansions 116/120, core 22/25, masters 18/21, commander 43/46, draft innovation 14/18, starter 7/11. Misses are mostly unreleased sets (`trk`, `nau`, `mdd`) and some promo or starter sets. Fallback for a missing glyph: label without icon, name only.
- Scryfall's `/sets` endpoint also returns `icon_svg_uri` per set. Not used: it needs another host permission and a network request per print.

## Cardmarket condition short codes

From `.docs/field-mappings.md` (verified on the live modal): MT Mint, NM Near Mint, EX Excellent, GD Good, LP Light Played, PL Played, PO Poor. Source of the grading rules: https://help.cardmarket.com/en/CardCondition (the page shows the codes as icons, so the text codes come from the sell form).

## Label options (phase 1)

Content, each switchable:

- Icon, name, set code (the three the user asked for).
- Foil mark (for foil boxes).
- Condition short code (MT/NM/EX/GD/LP/PL/PO).

Suggested additions, ordered by usefulness:

1. **Free text line** (box number, binder, owner). Boxes are usually numbered.
2. **Language code** (EN, DE, ...), same idea as condition: boxes are often sorted by language.
3. **Set range label**: one label for a box holding several sets ("ONS - SCG", two icons).
4. **Release year** of the set, helps with ordering old sets.
5. **Copies** per label (one for the front, one for the side).
6. **Layout**: icon left or right, text size auto-fit to the tape height, fixed or automatic label length, optional frame, inverted (white on black) style for divider cards.
7. **Group by** when taking sets from a loaded CSV: one label per set, or one per set + foil + condition.
8. **Saved presets** in `storage.local` (which fields are on, layout).
9. **QR code** to the Cardmarket expansion page or to a box id. Larger effort, so later.

Not planned: quantity (the user excluded it), colours (the tape is monochrome), card names.

## Option A and Option B

- **Option A (now):** panel button "Edition labels" opens `labels/labels.html`. The page offers the sets of the loaded CSV or binder (card counts shown only as a hint in the picker, not on the label) and a search over all Scryfall sets, so it also works without a CSV.
- **Option B (later):** a "Label" button on Cardmarket expansion or product pages. Cardmarket's DOM was not inspected. The set code would come from Scryfall `/cards/cardmarket/<idProduct>` (reverse lookup of the product id) or from the set name. The button only opens the same page with `?set=<code>`.

## Open points

- Firefox: Web Serial inside a `moz-extension://` page is unverified, WebUSB does not exist. Firefox keeps PNG export only until tested.
- Brave: Web Serial and WebUSB availability in Brave must be checked on the host (Brave can disable them). Phase 1 does not depend on it.
- The `/dev/usb/lp0` route and the raw `.prn` export are untested.
- A real print of the exported PNG on 24 mm tape decides whether the margins in the table above are right.

## Sources

- https://dt.in.th/BrotherPTWebUSB
- https://github.com/dtinth/p-touch-webusb
- https://github.com/fjanicki/ptouch
- https://github.com/jantman/pt-p710bt-label-maker
- https://developer.chrome.com/docs/extensions/how-to/web-platform/webusb
- https://hacks.mozilla.org/2026/05/web-serial-support-in-firefox/
- https://github.com/andrewgioia/keyrune
- https://download.brother.com/welcome/docp100064/cv_pte550wp750wp710bt_eng_raster_102.pdf
