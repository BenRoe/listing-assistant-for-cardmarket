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

test('[CONT-01/licence] labels/lib/cinzel ships only the font, OFL and FONTLOG', () => {
    assert.deepEqual(readdirSync(new URL('../labels/lib/cinzel/', import.meta.url)).sort(), ['FONTLOG.txt', 'OFL.txt', 'cinzel-bold-latin.woff2']);
    const font = read('labels/lib/cinzel/cinzel-bold-latin.woff2');
    assert.equal(font.subarray(0, 4).toString('latin1'), 'wOF2');
    assert.ok(font.length < 30000);
    assert.match(read('labels/lib/cinzel/OFL.txt').toString('utf8'), /Copyright 2020 The Cinzel Project Authors/);
    assert.ok(read('labels/lib/cinzel/FONTLOG.txt').toString('utf8').trim().length > 0);
});

test('[CONT-01/encoding] labels.html declares the Cinzel 700 face from lib/cinzel', () => {
    const html = read('labels/labels.html').toString('utf8');
    const face = html.match(/@font-face\s*\{[^}]*font-family:\s*Cinzel[^}]*\}/);
    assert.ok(face, 'no Cinzel @font-face');
    assert.match(face[0], /font-weight:\s*700/);
    assert.match(face[0], /url\(lib\/cinzel\//);
});

test('labels files never reference a path outside labels/', () => {
    for (const f of [...labelFiles('.js'), ...labelFiles('.html')]) {
        assert.ok(!read(`labels/${f}`).toString('utf8').includes('../'), `${f} contains ../`);
    }
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

const { readCsvSets } = require('../labels/csv-sets.js');
const LabelCore = require('../labels/core.js');

async function withApi(api, fn) {
    delete globalThis.chrome;
    delete globalThis.browser;
    if (api.chrome !== undefined) globalThis.chrome = api.chrome;
    if (api.browser !== undefined) globalThis.browser = api.browser;
    try {
        return await fn();
    } finally {
        delete globalThis.chrome;
        delete globalThis.browser;
    }
}
const storage = (data) => ({ storage: { local: { get: async () => data } } });
const fileOf = (binder, codes) => ({ binder, rows: codes.map(([setCode, setName, b]) => ({ setCode, setName, binder: b, qty: 99 })) });

test('[PAGE-05/empty] readCsvSets returns null when there is no extension API at all', async () => {
    assert.equal(await withApi({}, () => readCsvSets(LabelCore.groupCsvSets)), null);
});

test('[PAGE-05/empty] readCsvSets returns null for a bare chrome object without storage', async () => {
    assert.equal(await withApi({ chrome: {} }, () => readCsvSets(LabelCore.groupCsvSets)), null);
    assert.equal(await withApi({ chrome: { storage: {} } }, () => readCsvSets(LabelCore.groupCsvSets)), null);
});

test('[PAGE-05/empty] readCsvSets returns null when the storage read rejects', async () => {
    const chrome = { storage: { local: { get: async () => { throw new Error('denied'); } } } };
    assert.equal(await withApi({ chrome }, () => readCsvSets(LabelCore.groupCsvSets)), null);
});

test('[PAGE-05/empty] readCsvSets returns [] when storage holds no CSV', async () => {
    assert.deepEqual(await withApi({ chrome: storage({}) }, () => readCsvSets(LabelCore.groupCsvSets)), []);
    assert.deepEqual(await withApi({ chrome: storage({ csvs: {}, activeFile: 'a' }) }, () => readCsvSets(LabelCore.groupCsvSets)), []);
});

test('[PAGE-05/adjacency] readCsvSets prefers the active file and falls back to the first one', async () => {
    const csvs = { a: fileOf('', [['ONS', 'Onslaught', 'x']]), b: fileOf('', [['DOM', 'Dominaria', 'x']]) };
    const codes = async (data) => (await withApi({ chrome: storage(data) }, () => readCsvSets(LabelCore.groupCsvSets))).map((s) => s.code);
    assert.deepEqual(await codes({ csvs, activeFile: 'b' }), ['dom']);
    assert.deepEqual(await codes({ csvs, activeFile: 'missing' }), ['ons']);
});

test('[PAGE-05/adjacency] readCsvSets applies the binder rule and merges codes case-insensitively', async () => {
    const csvs = { a: fileOf('Binder A', [['ONS', 'Onslaught', 'Binder A'], ['dom', 'Dominaria', 'Binder A'], ['MOM', 'March', 'Binder B'], ['Ons', 'Other', 'Binder A']]) };
    const sets = await withApi({ chrome: storage({ csvs, activeFile: 'a' }) }, () => readCsvSets(LabelCore.groupCsvSets));
    assert.deepEqual(sets, [{ code: 'ons', name: 'Onslaught' }, { code: 'dom', name: 'Dominaria' }]);
});

test('[PAGE-05/adjacency] readCsvSets uses the browser namespace first when both exist', async () => {
    const browser = storage({ csvs: { a: fileOf('', [['ONS', 'Onslaught', '']]), }, activeFile: 'a' });
    const chrome = storage({ csvs: { a: fileOf('', [['DOM', 'Dominaria', '']]) }, activeFile: 'a' });
    const sets = await withApi({ browser, chrome }, () => readCsvSets(LabelCore.groupCsvSets));
    assert.deepEqual(sets.map((s) => s.code), ['ons']);
});
