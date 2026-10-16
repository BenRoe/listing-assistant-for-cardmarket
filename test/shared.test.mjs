import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Papa from '../lib/papaparse.min.js';

const { buildRows, parsePrice, formatPrice, median, computePrice, buildSearchUrl, DEFAULT_SETTINGS } = createRequire(import.meta.url)('../js/shared.js');

const csv = (f) => Papa.parse(readFileSync(new URL(`../example-csv/${f}`, import.meta.url), 'utf8'), { header: true, skipEmptyLines: true }).data;

test('collection export holds every list row once per binder', () => {
    const a = buildRows(csv('ManaBox_List.csv'));
    const b = buildRows(csv('ManaBox_Collection.csv'));
    assert.equal(a.rows.length, 24);
    assert.equal(b.rows.length, 48);
    assert.deepEqual([...new Set(b.rows.map((r) => r.binder))].sort(), ['Ordner', 'ordner1']);
    const names = (rows) => rows.map((r) => r.name + r.condition + r.qty);
    assert.deepEqual(names(b.rows.filter((r) => r.binder === 'Ordner')), names(a.rows));
});

test('the same CSV loaded as two files gets distinct keys', () => {
    const a = buildRows(csv('ManaBox_List.csv'), 'a.csv').rows.map((r) => r.key);
    const b = buildRows(csv('ManaBox_List.csv'), 'b.csv').rows.map((r) => r.key);
    assert.equal(new Set([...a, ...b]).size, 48);
    assert.deepEqual(a, buildRows(csv('ManaBox_List.csv'), 'a.csv').rows.map((r) => r.key));
});

test('identical cards get distinct keys, different conditions too', () => {
    const { rows } = buildRows(csv('ManaBox_List.csv'));
    assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
    const ditch = rows.filter((r) => r.name === 'Irrigation Ditch');
    assert.deepEqual(ditch.map((r) => r.condition), ['good', 'played']);
});

test('price parsing and formatting', () => {
    assert.equal(parsePrice('0,21 €'), 0.21);
    assert.equal(parsePrice('1.234,50 €'), 1234.5);
    assert.equal(parsePrice('—'), null);
    assert.equal(formatPrice(0.5), '0,50');
});

test('median of an odd and an even number of values', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), null);
});

test('computePrice: median, lowest, multiplier, minimum, none, no offers', () => {
    const offers = ['2,63 €', '2,63 €', '2,79 €', '3,99 €', '4,50 €', '4,70 €', '10,00 €', '10,15 €', '13,50 €'];
    assert.equal(computePrice(DEFAULT_SETTINGS, offers), 4.5);
    assert.equal(computePrice({ ...DEFAULT_SETTINGS, priceSource: 'lowest' }, offers), 2.63);
    assert.equal(computePrice({ ...DEFAULT_SETTINGS, multiplier: 50 }, offers), 2.25);
    assert.equal(computePrice({ ...DEFAULT_SETTINGS, priceSource: 'lowest' }, ['0,01 €']), 0.02);
    assert.equal(computePrice({ ...DEFAULT_SETTINGS, priceSource: 'none' }, offers), null);
    assert.equal(computePrice(DEFAULT_SETTINGS, []), null);
});

test('search URL: row filters only, foil always explicit', () => {
    const base = { language: 'de', condition: 'good', foil: 'normal' };
    assert.equal(buildSearchUrl(base, 3520, 'en'), '/en/Magic/Products?idProduct=3520&language=3&minCondition=4&isFoil=N');
    assert.equal(buildSearchUrl({ ...base, foil: 'foil' }, 3520, 'en'), '/en/Magic/Products?idProduct=3520&language=3&minCondition=4&isFoil=Y');
    assert.equal(buildSearchUrl({ ...base, language: 'xx', condition: '' }, 1, 'de'), '/de/Magic/Products?idProduct=1&isFoil=N');
});
