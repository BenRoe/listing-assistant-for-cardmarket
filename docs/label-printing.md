# Edition labels for storage boxes (Brother PT-P710BT)

Research and decisions for a new feature: print or export storage-box labels with the MTG edition icon, the edition name and optional extras. Research date: 2026-10-20. Printing over USB is built and hardware-tested on a PT-P710BT (see the results below); Bluetooth is deferred.

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

## Protocol sources and cross-checks

- Brother, [Raster Command Reference PT-E550W/P750W/P710BT](https://download.brother.com/welcome/docp100064/cv_pte550wp750wp710bt_eng_raster_102.pdf): the source of truth. Its terms forbid redistribution, so the PDF is linked and never committed.
- [treideme/brother_pt](https://github.com/treideme/brother_pt) (Apache-2.0, Python, 34 stars): golden-byte cross-check.
- [jantman/pt-p710bt-label-maker](https://github.com/jantman/pt-p710bt-label-maker) (CC-BY-4.0, credited here as required, Python, hardware-tested): second cross-check.
- [fjanicki/ptouch](https://github.com/fjanicki/ptouch) (Apache-2.0 or MIT; `docs/PROTOCOL.md` for the status-reply fields): hardware-tested on the PT-P710BT over USB and Bluetooth, very new as of 2026-10. Rust/WASM library plus web studio (https://fjanicki.github.io/ptouch/), useful as a fallback tool that imports the exported PNG.
- [dtinth/p-touch-webusb](https://github.com/dtinth/p-touch-webusb) (Apache-2.0): rejected as a code base (3 stars, 5 commits, one day of work, not well tested). Kept only as a third opinion that raw uncompressed lines print on a PT-P710BT.

The plugin encoder is written from the Brother reference. Nothing is copied or vendored, so no Apache NOTICE file is needed.

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

## Cut and no-cut behaviour (hardware findings, 2026-10-21)

Tested on a PT-P710BT over USB, 24 mm laminated TZe, Brave on macOS. Constants and job builder: `labels/ptouch.js`, chain handling: `labels/printer.js`, `labels/print-ui.js`.

### Margins

- The head sits about 25 mm before the cutter. That tape cannot be used: with cut on, the printer feeds it and trims it off before each label.
- Cut on, `ESC i d` margin 14 dots (2 mm) plus 14 trailing blank lines: measured end 6 mm, start 4-5 mm. Target is 6 mm at both ends, so `LEAD_DOTS = 10` (about 1.4 mm) blank lines are sent before the artwork. Not yet re-measured with the lead lines.
- Cut off, first label: the start margin is about 25 mm (the head-to-cutter tape, nothing trims it). Software cannot shrink it. Brother's own guide says the same: about 25 mm of leader before a new label.

### Cut off: what the bytes do

| Setting | Result |
| --- | --- |
| `ESC i M 0x00` (auto cut off) with `ESC i K 0x08` | Printer still cuts after each label. Auto cut off alone is not enough. |
| `ESC i M 0x00` with `ESC i K 0x18` (bit 4, no cut) | No cut. A single label feeds out by itself. Two separate no-chain jobs leave about 33 mm between labels (25 mm feed to the cutter plus margins). |

`ESC i K` bit 3 is "no chain printing": the strip is fed out after the last label. Bit 4 is "special tape, no cut".

### Chain printing (cut off, batches)

- Every label except the last: `ESC i K 0x10` (chain, no cut), job ends with `0x0C` (print, keep the label in the head). No feed to the cutter, so no 25 mm gap. Measured gap between two labels: 10-11 mm.
- Later labels of a chain are continuation pages: only `ESC i z` (print info, "not first page" byte `0x01`) plus raster plus terminator. No 100-byte invalidate, no `ESC @`, no status request.
- **A reset drops the chain.** The first attempt reset the printer (`invalidate`, `ESC @`, status request) before every job. The printer accepted the second job, reported "Printed 2 of 2", and printed nothing. The held label stayed in the head. `printer.js` therefore skips `readStatus` while `held` is set; any error clears it.
- Status frames of a chained job look like a normal job: `type6 phase1`, `type1 phase1` (complete), `type6 phase0`. The printer does send a completion frame for `0x0C`, so no special wait is needed.
- The last label ends with `0x1A`, preceded by `ESC i K 0x18` on its own page. It moves a little further but is not fed fully out: it stays in the head. Repeating `ESC i M`, `ESC i K` and `ESC i d` on the last page was tried and not kept. The owner accepted the result.
- **To eject and cut the last label: press the printer's power button twice quickly.** This is Brother's documented method. It feeds the strip out and cuts it, leaving about 30 mm of tape at the end. The label page shows this note whenever "Cut after each label" is off.

### Limits

- A trailing record that renders empty leaves the real last label chained in the head (power button twice ejects it).
- After an error mid-batch the printed labels stay in the head. The next Print starts a fresh job with a reset.
- A lone label with cut off does not chain and feeds out by itself.
- Cut on never chains.

## Direct print: hardware and browser results

Date 2026-10-21. Setup for every row unless noted: macOS 26.6.1, Brave 1.97.59, PT-P710BT over USB, 24 mm laminated TZe, P-touch Editor quit. Values are the owner's, verbatim where quoted.

| Check | Setup | Result | Notes |
| --- | --- | --- | --- |
| HW-1 first USB print | Brave, USB | ok | Not mirrored, no clipping, margin acceptable (details in 02-01-SUMMARY.md). Trailing end wished 2 mm longer, done with `TRAIL_DOTS`. |
| HW-2 copies and batch | Brave, USB | ok | 2a: 3 copies, 3 labels, each cut separately. 2b: switching the printer off during label 1 gave "Connection lost: Failed to execute 'transferIn' on 'USBDevice': The device was disconnected. The printer may have switched itself off. 0 of 3 printed. Press Connect to reconnect." (3 is the owner's own quantity of 2 + 1, not a counting error). 2c: one click on Connect USB without chooser, Print all printed only the remaining labels, 4 labels in total, no duplicates. |
| HW-3 Bluetooth | Brave, Web Serial | failed, deferred | `SDP query timeout`, see Key Decisions D-17 in PROJECT.md. |
| HW-4 error sentences | - | not run | Only a 24 mm cassette was available. 12 mm cassette, no cassette and open cover are still to test. |
| HW-5 power off | Printer idle until it switched itself off | ok | One click on Connect USB reconnects. |
| HW-6 cut off | Cut after each label unticked | see "Cut and no-cut behaviour" | With `ESC i K 0x08` the printer still cut at the end of each label; `0x18` stopped the cut. The printer does not cut at the start of the label with cut off. |
| HW-7 Firefox 158.0.1 (aarch64) | `about:debugging`, temporary add-on | USB disabled as designed | Reason text next to Connect USB: "USB needs a Chromium based browser". Refresh button disabled. PNG download (single and ZIP) works. |
| HW-8 lengths | Brave, USB | ok | Shortest label (icon only) and the long Commander Legends label (250 mm limit) both printed completely. |
| HW-9 margin | Cut on | start 4-5 mm, end 6 mm; wished 6 mm at both ends | Fixed with `LEAD_DOTS = 10` (about 1.4 mm); not re-measured. With cut off the start margin is about 25 mm (head-to-cutter tape), see below. |

### Browser outcome

- Brave on macOS, USB: works (single label, copies, batch, resume, reconnect, power-off recovery).
- Brave on macOS, Bluetooth: does not work (0 of 1 opens), deferred.
- Firefox 158.0.1: no direct print (no WebUSB). Connect USB is disabled with a reason, PNG and ZIP export work.

### Open problems

- HW-4 not run (12 mm cassette, no cassette, cover open).
- 6 mm start margin with cut on not re-measured after `LEAD_DOTS`.
- Cut off, last label of a batch stays in the head; power button twice ejects and cuts it (documented on the page).
- `tools/smoke-labels.mjs` was not re-run after the cut-off and chain changes (needs Playwright, not run in CI).

## Hosting the label page (PRNT-06)

Evidence: Brave randomises canvas readback on normal web pages but returned exact values in an extension page in the research probe; `toBitmap` thresholds at luminance 128, so pure black and white pixels are unaffected, but anti-aliased edges near the threshold can flip on a hosted page and print differently per session. A hosted page cannot read the loaded CSV from `storage.local` and keeps only the `#sets=` fragment. Firefox has no WebUSB on any origin.

Recommendation: do not host in this phase.

Owner decision (D-16): "github page not in this phase. move to later".

## Open points

- Firefox and Brave results: see "Direct print: hardware and browser results".
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
