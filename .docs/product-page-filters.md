# Product page: URL filters, sell form, offers

The plugin's flow runs on the Singles product page, not in the popup.

## Opening a product

`/en/Magic/Products?idProduct=<id>&<filters>` redirects to the canonical page, for example
`/en/Magic/Products/Singles/Invasion/Irrigation-Ditch?sellerCountry=7&...`, and keeps the filter query. No slug building from set and card names is needed.

## Filter parameters (verified)

| Parameter | Meaning | Values |
| --- | --- | --- |
| `language` | languages shown | ids from [field-mappings.md](field-mappings.md), comma separated (`1,3`) |
| `minCondition` | at least this condition | 1 to 7, e.g. `4` = Good or better |
| `isFoil` | foil filter | `Y` yes, `N` no, empty = any |
| `sellerCountry` | seller location | `7` = Germany |
| `sellerReputation` | minimum seller reputation | e.g. `3` |

## Saved default filter

A request without a parameter gets the account's saved filter value for it. Verified with `?idProduct=3520` only: it redirected to `?sellerCountry=7&sellerReputation=3&language=1,3&minCondition=2&isFoil=Y` (this account's saved defaults). Parameters in the URL override the saved ones, and visiting with other values did not change the saved defaults (a later bare visit again returned the same values).

Consequence for the plugin:

- It sends only what depends on the CSV row: `language` (card language), `minCondition` (card condition), `isFoil`.
- `isFoil` is always sent: `Y` for foil and etched, `N` for normal. If it were left out for normal cards, a saved default of `isFoil=Y` would apply and show foil offers.
- `sellerCountry`, `sellerReputation` and all other filters stay with the user's saved filter.

## Page layout

- Header: `header#header.fixed-top` (fixed) followed by `main.container`. The plugin panel is the first child of `main.container`, so it sits directly under the search bar.
- Tab container `div.tab-container` with tabs Info, Sell, Wants (`a[href="#tabContent-sell"]`, pane `#tabContent-sell`).
- Sell form: `form#ListProductForm`, same fields as the popup (see [mixed-products-modal.md](mixed-products-modal.md)), `action="/en/Magic/PostGetAction/Article_ListProduct"`, `method="post"`.
- Filter sidebar: `form#FilterForm`.
- Offers: rows `.article-row[id^="articleRow<id>"]`; price in `.price-container` (first match per row, text like `2,63 €`). The first page shows up to about 50 offers.

## Submitting (second test, see [submit-test.md](submit-test.md))

The product page form is a full page POST (not XHR). The browser is redirected to the same product page and the page shows:

- `<div class="alert systemMessage alert-success ...">Your item(s) have been listed!</div>` (text is translated; the classes are not)
- the new own row `#stockRow<articleId>` in the offers table.
