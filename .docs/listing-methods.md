# Cardmarket listing methods

`https://www.cardmarket.com/en/Magic/Stock/ListingMethods` lists exactly two methods:

| Method | URL | Input |
| --- | --- | --- |
| List Mixed Products | `/en/Magic/Stock/ListingMethods/ListMixedProducts` | Search box, then one modal per product |
| Bulk List Cards | `/en/Magic/Stock/ListingMethods/BulkListing` | Per-expansion table, max 300 cards per filter, see [bulk-listing-limits.md](bulk-listing-limits.md) |

## There is no CSV upload

- `ListMixedProducts` contains no `<input type="file">` (checked).
- `/en/Magic/Stock` has no import/export links and no file input.
- Any "Browse" button seen on `ListMixedProducts` comes from a browser extension (the `cardmarket-helper` extension injects its own file input under the breadcrumb).

## ListMixedProducts search form

- Form id `ProductSearchForm`, `method="post"`, action = the page itself.
- Fields: `__cmtkn` (CSRF, hidden), `searchString`, `idCategory` (11 options, `1` = Singles), `idLanguage` (17 options), `idExpansion` (769 options).
- Submitting runs an XHR `POST /en/Magic/AjaxAction/Stock_ListingMethods_SearchProducts`; results are links that open the list modal, see [mixed-products-modal.md](mixed-products-modal.md).
- The plugin does not need the search: it can open the modal directly from an `idProduct`.
