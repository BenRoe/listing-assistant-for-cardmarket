# Submit tests (two real listings)

Test 1 used the popup on `ListMixedProducts`; test 2 used the sell form on the product page. The plugin uses the product page flow, see [Test 2](#test-2-product-page-sell-form).

## Test 1: popup on ListMixedProducts

Done on 2026-10-16 with the account owner's consent. One card was listed at a price far above the market so it cannot sell, and the owner deletes it afterwards.

## Input

Row from `example-csv/ManaBox_List.csv`:
`Irrigation Ditch, INV, Invasion, 324, normal, common, qty 1, Scryfall ID 977f1b44-166c-4faf-8a7b-d431707e90ce, condition good, language de`

- Scryfall `cardmarket_id` = `3520` -> `idProduct=3520`.
- Modal values: `amount=1`, `idLanguage=3` (German), `idCondition=4` (Good), `isFoil=false`, `price=19,99`, `saveSettings` unchecked.
- Market at the time: lowest 0,02 EUR, 30-day average 0,21 EUR, chart peak about 1,2 EUR.

## What happened (recorded with injected fetch/XHR hooks and a MutationObserver)

1. `submit` event fired on `#ListProductForm`, not prevented.
2. XHR `POST /en/Magic/AjaxAction/Article_ListProduct` with `FormData` body (the form fields).
3. Response: HTTP 200, `application/xml` body:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <ajaxResponse><newArticleRow>BASE64-ENCODED HTML OF THE NEW ROW</newArticleRow>...
   ```

   The base64 decodes to the markup of `<div id="stockRow2181497985" class="row g-0 article-row">`, so the new article ID is `2181497985`.
4. The modal closed (`#modal` lost class `show`, its content was emptied).
5. A new row appeared on the page itself: `#stockRow2181497985` inside `.table-body`, text `Irrigation Ditch GD 19,99 € 1`.
6. Cardmarket then submitted its own `ProductSearchForm` again (`POST .../Stock_ListingMethods_SearchProducts`, response `<ajaxResponse/>`), so the search state refreshes by itself.
7. No `alert`, `toast` or success text was shown. The row is the only feedback.

Created article: **2181497985** (delete it in My Offers).

## Success signal for the plugin

Reliable and language independent: a new element matching `.article-row[id^="stockRow"]` appears in the page after the user pressed "Put for sale".

- Observe `document.body` (or the `.table-body`) with a MutationObserver for added nodes with id `stockRow<digits>`.
- Pair it with the last modal opened by the plugin: the row's product link contains the product slug and the row has the same condition/price; the simplest rule is "the modal was opened for row X, it closed, and a new `stockRow` appeared" -> mark X done.
- A failed submit is unverified (no failure was triggered). Expected: modal stays open, no new row. The plugin must not mark done in that case.

## Not tested

- Failure responses (invalid price, duplicate article, session expired).
- Foil, signed, altered flags on a real submission.
- Whether Cardmarket merges identical articles (same product, language, condition, foil) into one row with a higher quantity. The row shows a `groupCount`/`Amount` element, so merging is likely.

## Test 2: product page sell form

Done on 2026-10-16 with the account owner's consent, through the plugin's Search flow.

Input: Irrigation Ditch, second CSV row (played, German, normal, qty 1). Plugin opened
`/en/Magic/Products/Singles/Invasion/Irrigation-Ditch?sellerCountry=7&sellerReputation=3&language=3&minCondition=6&isFoil=N`
and filled the Sell tab: `amount=1`, `idLanguage=3`, `idCondition=6`, price `0,10` (median of 50 offers). The price was then overridden to `19,99` by hand so the test listing cannot sell.

Recorded (hooks writing into `sessionStorage` survive the reload):

1. `submit` event on `#ListProductForm`, `action="/en/Magic/PostGetAction/Article_ListProduct"`, not prevented.
2. No XHR/fetch to Cardmarket (only third-party analytics calls). `beforeunload` fires: this is a normal form POST with a navigation.
3. The browser lands on the same product page URL with the same query, navigation type `navigate`, referrer = the product page.
4. The reloaded page contains `.alert.systemMessage.alert-success` with text "Your item(s) have been listed!".
5. The offers table contains the new own row `#stockRow2181529523` with text `0 - <user name> PL 19,99 € 1`.

Created article: **2181529523** (delete it in My Offers).

### Success signal used by the plugin

- On `submit` of `#ListProductForm` the plugin writes a timestamp into `sessionStorage` (`cmlp.submitAt`, no card data).
- On the next page load, within 60 seconds: if `.systemMessage.alert-success` exists, the row is marked listed and the article ID is the highest `#stockRow<id>` on the page. If the alert is missing, the row stays open and the panel says the submit was not confirmed.
- The detection was exercised with a simulated alert and row (a hook event `cmlp-check`), plus the real result of this test. A failed submit was not tested.
