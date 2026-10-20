// The only labels/ file that touches the extension storage API: one optional read of the loaded CSV.
// Returns null when no usable storage exists (hosted copy, ordinary page, rejected read), [] when no CSV is stored.
async function readCsvSets(group) {
    const ext = globalThis.browser ?? globalThis.chrome;
    if (typeof ext?.storage?.local?.get !== 'function') return null;
    try {
        const { csvs, activeFile } = await ext.storage.local.get(['csvs', 'activeFile']);
        const file = csvs?.[activeFile] ?? Object.values(csvs ?? {})[0];
        return file ? group(file) : [];
    } catch {
        return null;
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { readCsvSets };
