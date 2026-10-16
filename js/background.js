const ext = globalThis.browser ?? globalThis.chrome;

const SCRYFALL_COLLECTION = 'https://api.scryfall.com/cards/collection';

async function fetchCollection(ids) {
    const body = JSON.stringify({ identifiers: ids.map((id) => ({ id })) });
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(SCRYFALL_COLLECTION, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body
        });
        if (res.status === 429 && attempt === 0) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
        }
        if (!res.ok) throw new Error(`Scryfall HTTP ${res.status}`);
        const json = await res.json();
        const cards = {};
        for (const c of json.data || []) {
            cards[c.id] = {
                idProduct: c.cardmarket_id ?? null,
                name: c.name,
                finishes: c.finishes || [],
                eur: c.prices?.eur ? Number(c.prices.eur) : null,
                eurFoil: c.prices?.eur_foil ? Number(c.prices.eur_foil) : null
            };
        }
        for (const nf of json.not_found || []) {
            if (nf.id) cards[nf.id] = { idProduct: null };
        }
        return { ok: true, cards };
    }
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'scryfallCollection') {
        fetchCollection(msg.ids).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
        return true;
    }
    if (msg?.type === 'openOptions') {
        ext.runtime.openOptionsPage();
    }
});
