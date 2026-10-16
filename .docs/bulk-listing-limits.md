# Bulk listing page

Not used by this plugin, but it explains why the existing bulk-import extension imports nothing for many CSVs.

## Filter (plain GET)

`/en/Magic/Stock/ListingMethods/BulkListing?idExpansion=<id>&idRarity=<id>&sortBy=<sort>&site=<page>`

- `idExpansion`: e.g. `31` = Mercadian Masques, `34` = Invasion.
- `sortBy`: `number`, `engName`, `locName`, `rarenumber`.
- `site`: page number, 100 cards per page.
- The "Bulk modification" accordion (`div#BulkAccordion`) and every article row only exist after an expansion is chosen. Without `idExpansion` there is no table.

## 300-card cap

Each filter returns at most 3 pages (300 cards). Verified on Invasion (350 cards): pages 1 to 3 have 100 cards each, `site=4` is empty. Sorted by `engName`, page 3 ends at "Tranquility", so the end of the alphabet is not reachable. Sorted by `number`, cards with high collector numbers (lands, #319 and up in INV/MMQ) are cut off. That is why the example CSV (all lands) matched nothing.

Workaround: add `idRarity`. Rarity IDs: 17 Mythic, 18 Rare, 21 Uncommon, 22 Common, 23 Land (basic lands only, e.g. "Plains (V.1)"), 19 Special, 24 Token, 20 Time Shifted, 64 Masterpiece, 155 Code Card, 55 Tip Card. Whether non-basic lands such as Irrigation Ditch are reachable through Common/Uncommon was not fully checked.

## Row markup

Every article row has hidden inputs `idProduct[i]`, `idLanguage[i]`, `idCondition[i]`, `isFoil[i]`, `isSigned[i]`, `comments[i]`, `amount[i]`, `price[i]`. Matching rows by `idProduct` is exact; matching by card name (as `cardmarket-bulk-import` does) is fuzzy.
