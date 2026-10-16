# Field mappings

## Condition (`idCondition`)

Confirmed in the live modal (value 3 renders "Excellent", the new row for value 4 shows `GD`).

| ManaBox `Condition` | Cardmarket | `idCondition` |
| --- | --- | --- |
| `mint` | Mint (MT) | 1 |
| `near_mint` | Near Mint (NM) | 2 |
| `excellent` | Excellent (EX) | 3 |
| `good` | Good (GD) | 4 |
| `light_played` | Light Played (LP) | 5 |
| `played` | Played (PL) | 6 |
| `poor` | Poor (PO) | 7 |

Unknown value: fall back to `2` (Near Mint) and flag the row.

## Language (`idLanguage`)

Confirmed by the modal option labels (1 English, 2 French, 3 German, 4 Spanish, 5 Italian, 6 S-Chinese, 7 Japanese, 8 Portuguese, 11 T-Chinese). 9 and 10 come from the existing `cardmarket-helper` code (`LANG_MAP`).

| ManaBox `Language` | `idLanguage` |
| --- | --- |
| `en` | 1 |
| `fr` | 2 |
| `de` | 3 |
| `es` | 4 |
| `it` | 5 |
| `zh_CN` / `zhs` | 6 |
| `ja` | 7 |
| `pt` | 8 |
| `ru` | 9 |
| `ko` | 10 |
| `zh_TW` / `zht` | 11 |

The modal only offers the languages the product exists in. If the wanted value is not an `<option>`, do not force it: leave the default and flag the row.

## Other fields

| ManaBox | Modal field | Rule |
| --- | --- | --- |
| `Quantity` | `amount` | as is |
| `Foil` = `foil` or `etched` | `isFoil` | checked; `normal` -> unchecked |
| `Signed` = `true` | `isSigned` | checked |
| `Altered` = `true` | `isAltered` | checked |
| `Misprint` = `true` | `comments` | no Cardmarket field; optionally write "Misprint" into the comment |
| (none) | `comments` | empty by default |
| (none) | `price` | from the price source setting, see [price-sources.md](price-sources.md) |
| (none) | `saveSettings` | uncheck |
