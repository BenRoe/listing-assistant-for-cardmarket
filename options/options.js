const ext = globalThis.browser ?? globalThis.chrome;
const fields = ['priceSource', 'multiplier', 'round', 'minPrice', 'commentMisprint', 'keepAlive'];

function read() {
    const s = {};
    for (const id of fields) {
        const e = document.getElementById(id);
        s[id] = e.type === 'checkbox' ? e.checked : (e.type === 'number' || id === 'round' ? Number(e.value) : e.value);
    }
    return s;
}

(async function init() {
    const { settings } = await ext.storage.local.get('settings');
    const current = { ...CMLP.DEFAULT_SETTINGS, ...(settings || {}) };
    for (const id of fields) {
        const e = document.getElementById(id);
        if (e.type === 'checkbox') e.checked = current[id];
        else e.value = current[id];
        e.addEventListener('change', () => ext.storage.local.set({ settings: read() }));
    }
})();

function clearKey(buttonId, key, question, done) {
    document.getElementById(buttonId).addEventListener('click', async () => {
        if (!confirm(question)) return;
        await ext.storage.local.remove(key);
        document.getElementById('dataStatus').textContent = done;
    });
}

clearKey('clearDone', 'done', 'Forget which cards were marked as listed (all CSV files)?', 'Listed flags cleared. Reload open Cardmarket tabs.');
clearKey('clearCache', 'scryfall', 'Delete the cached Cardmarket IDs? They are looked up again on the next page load.', 'ID cache cleared. Reload open Cardmarket tabs.');
