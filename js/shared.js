// Pure helpers shared by content script, options page and tests. No DOM access here.
(function (root) {
    const CONDITION_ID = { mint: 1, near_mint: 2, excellent: 3, good: 4, light_played: 5, played: 6, poor: 7 };

    const LANGUAGE_ID = {
        en: 1, fr: 2, de: 3, es: 4, it: 5, zh_cn: 6, zhs: 6, ja: 7, pt: 8, ru: 9, ko: 10, zh_tw: 11, zht: 11
    };

    const DEFAULT_SETTINGS = {
        priceSource: 'median',    // median | lowest of the offers shown for the applied filter | none
        multiplier: 100,          // percent
        round: 0.01,              // 0.01 | 0.05
        minPrice: 0.02,           // the form rejects 0,00 and 0,01
        commentMisprint: true
    };

    const bool = (v) => String(v || '').trim().toLowerCase() === 'true';

    function rowKey(row, occurrence) {
        return [row.file, row.binder, row.scryfallId, row.foil, row.condition, row.language, row.altered, row.signed, occurrence].join('|');
    }

    // Turns Papa Parse output (header: true) into listing rows. Works for list and collection exports.
    // fileId (unique per loaded CSV) is part of every row key, so each loaded CSV keeps its own done flags.
    function buildRows(csvRows, fileId = '') {
        const rows = [];
        const seen = {};
        let skipped = 0;
        for (const r of csvRows) {
            const scryfallId = String(r['Scryfall ID'] || '').trim();
            const name = String(r['Name'] || '').trim();
            if (!scryfallId || !name) { skipped++; continue; }
            const row = {
                file: fileId,
                scryfallId,
                name,
                binder: String(r['Binder Name'] || '').trim(),
                binderType: String(r['Binder Type'] || '').trim(),
                setCode: String(r['Set code'] || '').toUpperCase(),
                setName: r['Set name'] || '',
                number: r['Collector number'] || '',
                rarity: r['Rarity'] || '',
                foil: String(r['Foil'] || 'normal').trim().toLowerCase(),
                qty: Math.max(1, parseInt(r['Quantity'], 10) || 1),
                condition: String(r['Condition'] || '').trim().toLowerCase(),
                language: String(r['Language'] || '').trim().toLowerCase().replace('-', '_'),
                altered: bool(r['Altered']),
                signed: bool(r['Signed']),
                misprint: bool(r['Misprint'])
            };
            const base = rowKey(row, '');
            seen[base] = (seen[base] || 0) + 1;
            row.key = rowKey(row, seen[base]);
            rows.push(row);
        }
        return { rows, skipped };
    }

    // "0,21 €" -> 0.21 ; "1.234,50 €" -> 1234.5 ; unparsable -> null
    function parsePrice(text) {
        let s = String(text || '').replace(/[^\d,.-]/g, '');
        if (!s) return null;
        if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
    }

    function formatPrice(n) {
        return n.toFixed(2).replace('.', ',');
    }

    function median(nums) {
        const a = [...nums].sort((x, y) => x - y);
        if (!a.length) return null;
        const m = a.length >> 1;
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    }

    // offerTexts: price texts ("2,63 €") of the offers shown for the applied filter.
    // Returns a number or null (null = leave the price empty).
    function computePrice(settings, offerTexts) {
        if (settings.priceSource === 'none') return null;
        const prices = offerTexts.map(parsePrice).filter((n) => n != null && n > 0);
        let value = settings.priceSource === 'lowest' ? Math.min(...prices) : median(prices);
        if (value == null || !Number.isFinite(value)) return null;
        const step = Number(settings.round) || 0.01;
        value = Math.round((value * Number(settings.multiplier) / 100) / step) * step;
        return Math.max(value, Number(settings.minPrice) || 0.02);
    }

    // Product page URL (Cardmarket redirects idProduct to the canonical slug and keeps the query).
    // Only the filters that depend on the CSV row are sent (language, minimum condition, foil);
    // everything else (seller country, reputation, ...) comes from the user's saved Cardmarket filter.
    // Foil is always explicit: a saved default of isFoil=Y would otherwise apply to normal cards.
    function buildSearchUrl(row, idProduct, lang) {
        const q = [['idProduct', idProduct]];
        if (LANGUAGE_ID[row.language]) q.push(['language', LANGUAGE_ID[row.language]]);
        if (CONDITION_ID[row.condition]) q.push(['minCondition', CONDITION_ID[row.condition]]);
        q.push(['isFoil', row.foil === 'foil' || row.foil === 'etched' ? 'Y' : 'N']);
        return `/${lang}/Magic/Products?` + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    }

    const api = { CONDITION_ID, LANGUAGE_ID, DEFAULT_SETTINGS, buildRows, parsePrice, formatPrice, median, computePrice, buildSearchUrl };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.CMLP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
