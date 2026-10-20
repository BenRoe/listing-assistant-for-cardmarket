# Privacy policy: Listing Assistant for Cardmarket

- **No telemetry, no analytics, no tracking, no accounts.** The extension collects nothing about you.
- **The only external requests** go to `api.scryfall.com`. First, the Scryfall IDs of your CSV cards, to look up Cardmarket product IDs. Second, when you open the Edition labels page, one `GET https://api.scryfall.com/sets` for the public list of sets; it sends no data except what any web request exposes (your IP address) and the answer is cached for 24 hours. Like any web request both expose your IP address to Scryfall. Nothing else is sent: not your prices, quantities, conditions, file names or Cardmarket account data.
- **Everything else stays in your browser**: the loaded CSVs, the ID cache, listed flags, settings and panel state live in the extension's local storage (`storage.local`, not synced to any account). The Cardmarket tab's `sessionStorage` holds a timestamp to detect a finished listing (no card data) and, for a few seconds around a filter reload, the sell form's values (quantity, language, condition, flags, comment, price); both are removed again and vanish with the tab.
- **The Edition labels page** keeps its preferences and the cached public set list in its own `localStorage` (not synced). It stores no CSV data, card names, quantities or prices.
- **Label page URL fragment and files**: set codes in the `#sets=` URL fragment are never sent to any server. PNG and ZIP files are generated in the page and never uploaded.
- On Cardmarket the extension only reads the page you have open and fills the form fields; the product pages it opens are normal page loads in your own tab. It never submits a listing for you. With the optional "Stay logged in" setting (off by default), an open tab also requests one Cardmarket page (`/<lang>/Magic`) every 30 minutes, the same as a reload; the response is discarded.
- Delete data with "Remove CSV" in the panel, "Clear listed flags" and "Clear Cardmarket ID cache" on the options page, or by removing the extension. The label page data goes with the extension or when you clear its site data.
- No data is sold, shared or transferred to anyone besides Scryfall as described above.

Contact: open an issue in this repository.
