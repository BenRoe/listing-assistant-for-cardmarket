import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const labelFiles = (ext) => readdirSync(new URL('../labels/', import.meta.url))
    .filter((f) => f.endsWith(ext) && f !== 'csv-sets.js');   // csv-sets.js (plan 01-04) is the one file allowed to use the extension API

test('[PAGE-05/adjacency] no labels page file mentions the extension API, comments included', () => {
    const forbidden = [/\b(chrome|browser)\./, /globalThis\.(chrome|browser)\b/, /\b(chrome|browser)\s*\?\./];
    const files = [...labelFiles('.js'), ...labelFiles('.html')];
    assert.ok(files.includes('labels.js') && files.includes('labels.html'));
    for (const f of files) {
        const text = read(`labels/${f}`).toString('utf8');
        for (const re of forbidden) assert.doesNotMatch(text, re, `${f} matches ${re}`);
    }
});

test('labels scripts show data only through textContent: no HTML sink, eval or new Function', () => {
    const sinks = [/\.(innerHTML|outerHTML)\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/];
    for (const f of labelFiles('.js')) {
        const text = read(`labels/${f}`).toString('utf8');
        for (const re of sinks) assert.doesNotMatch(text, re, `${f} matches ${re}`);
    }
});

test('[ICON-03/empty] labels/lib/keyrune ships only the font and the licence', () => {
    assert.deepEqual(readdirSync(new URL('../labels/lib/keyrune/', import.meta.url)).sort(), ['LICENSE.md', 'keyrune.woff2']);
});

test('[ICON-03/encoding] the font is a real woff2 and the licence is the upstream text', () => {
    assert.equal(read('labels/lib/keyrune/keyrune.woff2').subarray(0, 4).toString('latin1'), 'wOF2');
    const licence = read('labels/lib/keyrune/LICENSE.md').toString('utf8');
    assert.ok(licence.length > 0);
    assert.match(licence, /OFL/);
    assert.match(licence, /GPL/);
});

test('manifest: permissions and content scripts are unchanged, nothing exposed to web pages', () => {
    const manifest = JSON.parse(read('manifest.json'));
    assert.deepEqual(manifest.permissions, ['storage']);
    assert.deepEqual(manifest.host_permissions, ['https://api.scryfall.com/*']);
    assert.equal('web_accessible_resources' in manifest, false);
    assert.deepEqual(manifest.content_scripts.map((c) => c.js), [['lib/papaparse.min.js', 'js/shared.js', 'js/content.js']]);
});

test('[PAGE-01/encoding] background opens only the fixed labels page and keeps its other handlers', async () => {
    const calls = { created: [], options: 0 };
    let listener;
    globalThis.chrome = {
        runtime: {
            onMessage: { addListener: (fn) => { listener = fn; } },
            getURL: (path) => `chrome-extension://test/${path}`,
            openOptionsPage: () => { calls.options++; }
        },
        tabs: { create: (args) => { calls.created.push(args); } }
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [], not_found: [] }) });
    try {
        require('../js/background.js');
        assert.equal(listener({ type: 'openLabels', url: 'https://evil.example/?sets=x' }, {}, () => {}), undefined);
        assert.deepEqual(calls.created, [{ url: 'chrome-extension://test/labels/labels.html' }]);
        listener({ type: 'openOptions' }, {}, () => {});
        assert.equal(calls.options, 1);
        assert.equal(listener({ type: 'scryfallCollection', ids: [] }, {}, () => {}), true);
    } finally {
        globalThis.fetch = realFetch;
        delete globalThis.chrome;
    }
    const source = read('js/background.js').toString('utf8');
    assert.equal(source.match(/tabs\.create/g).length, 1);
    assert.match(source, /ext\.runtime\.getURL\('labels\/labels\.html'\)/);
});

test('panel: content script has one Edition labels button that sends openLabels', () => {
    const source = read('js/content.js').toString('utf8');
    assert.equal(source.match(/'openLabels'/g).length, 1);
    assert.equal(source.match(/'Edition labels'/g).length, 1);
});
