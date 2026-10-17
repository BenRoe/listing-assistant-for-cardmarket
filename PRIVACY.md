# Privacy policy: Listing Assistant for Cardmarket

- **No telemetry, no analytics, no tracking, no accounts.** The extension collects nothing about you.
- **The only external request** is to `api.scryfall.com`, with the Scryfall IDs of your CSV cards, to look up Cardmarket product IDs. Like any web request it exposes your IP address to Scryfall. Nothing else is sent: not your prices, quantities, conditions, file names or Cardmarket account data.
- **Everything else stays in your browser**: the loaded CSVs, the ID cache, listed flags, settings and panel state live in the extension's local storage (`storage.local`, not synced to any account). The Cardmarket tab's `sessionStorage` holds a timestamp to detect a finished listing (no card data) and, for a few seconds around a filter reload, the sell form's values (quantity, language, condition, flags, comment, price); both are removed again and vanish with the tab.
- On Cardmarket the extension only reads the page you have open and fills the form fields; the product pages it opens are normal page loads in your own tab. It never submits a listing for you.
- Delete data with "Remove CSV" in the panel, "Clear listed flags" and "Clear Cardmarket ID cache" on the options page, or by removing the extension.
- No data is sold, shared or transferred to anyone besides Scryfall as described above.

Contact: open an issue in this repository.
