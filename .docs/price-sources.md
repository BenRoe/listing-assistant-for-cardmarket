# Price source

The plugin fills `price` from the offers Cardmarket shows on the product page for the applied filter, see [product-page-filters.md](product-page-filters.md). The popup price panel (`From`, 30/7/1-day averages) was dropped because it did not reflect the filtered market (language, condition, foil).

## Setting `priceSource`

| Value | Meaning |
| --- | --- |
| `median` (default) | median of the prices of all offers shown (first page, about 50 rows); even count = mean of the two middle values |
| `lowest` | lowest shown offer |
| `none` | leave the price empty |

Then `multiplier` (percent, default 100), `round` (0,01 or 0,05) and `minPrice` (default 0,02, the form rejects 0,00 and 0,01) apply.

If no offer matches the filter, the price stays empty and the panel says so; the plugin never invents a price.

## Parsing

Offer price text such as `2,63 €` or `1.234,50 €`: remove everything except digits, `,`, `.`, `-`; if a comma is present drop dots and use the comma as decimal separator. The form accepts `,` and `.`.

## Example

Irrigation Ditch, German, Good or better, non-foil, saved filter Germany/reputation 3: 9 offers `2,63 2,63 2,79 3,99 4,50 4,70 10,00 10,15 13,50` -> median `4,50`.

## Open points

- Only the first page of offers is read; with a very large market the median covers only the cheapest page (offers are sorted by price).
- The user's own offers are not excluded; Cardmarket did not list the test listing among the offers in tests.
