# ManaBox CSV formats

Examples live in `example-csv/`.

## List export (`ManaBox_List.csv`)

Header:

```
Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Signed,Condition,Language,Proxy,Purchase price currency,Added
```

## Collection export (`ManaBox_Collection.csv`)

Same columns plus two leading ones: `Binder Name,Binder Type,` then the list columns. Parse by header name, not by position, so both exports work.

**A collection export repeats cards per binder.** A real export of one user held the same 24 cards once in a binder (`Binder Type` = `binder`) and once in a list (`Binder Type` = `list`), 48 rows in total. The shortened example in `example-csv/` shows the same structure with 3 rows in the binders `Main Binder` and `Sell List`. Listing every row would list each card twice, so the plugin shows one binder at a time (default: the first) and offers "All binders".

## Values

| Column | Values seen / expected |
| --- | --- |
| `Foil` | `normal`, `foil`, `etched` |
| `Rarity` | `common`, `uncommon`, `rare`, `mythic` (others possible) |
| `Condition` | `mint`, `near_mint`, `excellent`, `good`, `light_played`, `played`, `poor` |
| `Language` | ManaBox/Scryfall codes: `en`, `de`, `fr`, `es`, `it`, `pt`, `ja`, `ko`, `ru`, `zh_CN`/`zhs`, `zh_TW`/`zht` |
| `Misprint`, `Altered`, `Signed`, `Proxy` | `true` / `false` |
| `Purchase price` | decimal with `.`, currency in `Purchase price currency` |
| `Scryfall ID` | UUID, the key for [id-mapping.md](id-mapping.md) |
| `ManaBox ID` | ManaBox internal card id, identical for every row of one card; not unique per row |

## Row identity

`ManaBox ID` and `Scryfall ID` repeat for identical cards (example: two Irrigation Ditch rows differing only in condition). A stable key for "done" tracking per row is
`fileId | binder | scryfallId | foil | condition | language | altered | signed | occurrence-index` where the index counts identical earlier rows. The file id (a load timestamp) keeps several loaded CSVs apart, even two loads of the same file name: the same card in two loaded CSVs has two independent done flags. Rows are also duplicated when the same card is in several binders (collection export), so identical keys add up as separate copies, not as one.

## Parsing notes

- Parse with a real CSV parser (quoted names contain commas).
- Skip empty trailing lines.
- `Added` is an ISO timestamp and can be ignored.
