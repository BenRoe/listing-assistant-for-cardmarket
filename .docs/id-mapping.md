# ManaBox card -> Cardmarket idProduct

## Chain

ManaBox CSV column `Scryfall ID` -> Scryfall card object -> field `cardmarket_id` = Cardmarket `idProduct`.

Verified:

| Card | Scryfall ID | `cardmarket_id` |
| --- | --- | --- |
| Irrigation Ditch (INV 324) | `977f1b44-166c-4faf-8a7b-d431707e90ce` | `3520` (matches the `idProduct=3520` Cardmarket modal for the same card) |
| Rushwood Grove (MMQ 325) | `c315c72c-3e2f-4aff-b7d7-2f709ccec332` | `11698` |

## Scryfall API

- Single: `GET https://api.scryfall.com/cards/<scryfall-id>`
- Batch: `POST https://api.scryfall.com/cards/collection` with `{"identifiers":[{"id":"<scryfall-id>"}, ...]}`, **max 75 identifiers per request**; response `data[]` plus `not_found[]`.
- Scryfall asks for a `User-Agent` and an `Accept` header and at most about 10 requests/second.
- Scryfall allows cross-origin requests (`access-control-allow-origin: *`), so a content script can call it directly; no background script is needed for that.
- Useful fields: `id`, `name`, `set`, `collector_number`, `rarity`, `cardmarket_id`, `finishes` (`nonfoil`, `foil`, `etched`), `prices.eur`, `prices.eur_foil`.

## Edge cases

- `cardmarket_id` can be missing (very new sets, some tokens/promos): show the row as "no Cardmarket ID" and skip it.
- Foil and non-foil of one printing usually share one `idProduct`; the foil state is the `isFoil` checkbox, not a different product. (The old helper readme lists exceptions such as Coastal Tower 8ED; those are unverified.)
- A ManaBox `Foil` value of `etched` has no Cardmarket equivalent in the modal (only the foil checkbox); treat it as foil and warn.
- Cache `scryfallId -> { idProduct, name, set, rarity, finishes, eurPrice }` in `storage.local`; the mapping does not change.
