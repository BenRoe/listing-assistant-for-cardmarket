# The list-product modal

Not used by the plugin any more: its price panel was not useful, so the plugin now fills the sell form on the product page, see [product-page-filters.md](product-page-filters.md). The field list below is still valid for that form.

## Opening it

Search results are anchors like:

```html
<a href="#" data-bs-toggle="modal" data-bs-target="#modal" data-backdrop="true"
   data-modal="/en/Magic/Modal/Stock_ListProductModal?idProduct=3520"
   class="modal-link vignette hvr-sweep-to-right h-auto">...</a>
```

Cardmarket's own JavaScript handles these anchors through delegation. Verified: appending an anchor with the same attributes to `document.body` and calling `.click()` opens the normal modal in `#modal` (class `show`). No search is needed.

The modal can also be fetched with a plain GET (`/en/Magic/Modal/Stock_ListProductModal?idProduct=3520`, status 200, HTML fragment).

## Form

Form `#ListProductForm`, `method="post"`, no `action` attribute (Cardmarket JS submits it by XHR, see [submit-test.md](submit-test.md)).

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `__cmtkn` | hidden | token | CSRF token, comes with the modal HTML |
| `idAddProduct` | hidden | the `idProduct` | |
| `amount` | number | `1` | quantity |
| `idLanguage` | select | `1` | option values depend on the product (a card printed in English/German only offers those); see [field-mappings.md](field-mappings.md) |
| `idCondition` | select | `2` (Near Mint) | values 1 to 7 |
| `comments` | text | empty | |
| `cardScanFile` | file | | optional image (.jpg) |
| `isFoil` | checkbox | unchecked | |
| `isSigned` | checkbox | unchecked | |
| `isAltered` | checkbox | unchecked | |
| `price` | text | empty | required; pattern rejects `0,00` and `0,01`; accepts `,` or `.` as separator, max 2 decimals |
| `saveSettings` | checkbox | **checked** | "remember language/condition as defaults" on the account; the plugin should uncheck it |
| submit | input | `Put for sale` | exists twice (desktop and mobile layout); use the first one |

The modal HTML contains four forms. The listing form is the one with `id="ListProductForm"`. Other forms handle the "Show Image" / "Show Chart" buttons.

## Filling it from code

Set `.value` (or `.checked`) and dispatch `input` and `change` events with `bubbles: true`. Verified visually: quantity, language, condition, comment and foil checkbox all render correctly after filling.

## Price panel inside the modal

A `<dl class="row mx-auto">` (rendered twice, desktop and mobile) with fixed order:

1. `Available items`
2. `From` (lowest price)
3. `30-days average price`
4. `7-days average price`
5. `1-day average price`

Labels are translated, so read by position, not by label. Values look like `0,21 €` (comma decimal). See [price-sources.md](price-sources.md).
