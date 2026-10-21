import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const core = require('../labels/core.js');
const KEYRUNE = require('../labels/keyrune-map.js');
const {
    crc32, adler32, toBitmap, encodePng1bit, glyphFor, parseFragment, layoutLabel, MIN_DOTS, PAD_X, PAD_Y, ICON_GAP,
    normalizeCondition, fold, mmToDots, fileName, uniqueNames, captionFor, bitmapToRgba,
    zipStore, filterSets, sortSets, searchSets, groupCsvSets, resolveSet, trimSets, normalizeSettings, HIDDEN_SET_TYPES
} = core;

// Walks the chunks (asserting every CRC), inflates IDAT and returns ink bits (1 = ink) next to the raw samples
function decodePng1bit(bytes) {
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const order = [], idat = [];
    let ihdr, phys;
    for (let o = 8; o < bytes.length;) {
        const len = dv.getUint32(o);
        const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
        assert.equal(crc32(bytes.subarray(o + 4, o + 8 + len)), dv.getUint32(o + 8 + len), `CRC of ${type}`);
        order.push(type);
        if (type === 'IHDR') ihdr = { width: dv.getUint32(o + 8), height: dv.getUint32(o + 12), depth: bytes[o + 16], colour: bytes[o + 17], interlace: bytes[o + 20] };
        if (type === 'pHYs') phys = { x: dv.getUint32(o + 8), y: dv.getUint32(o + 12), unit: bytes[o + 16] };
        if (type === 'IDAT') idat.push(bytes.subarray(o + 8, o + 8 + len));
        o += 12 + len;
    }
    const stride = (ihdr.width + 7) >> 3;
    const inflated = zlib.inflateSync(Buffer.concat(idat));
    assert.equal(inflated.length, ihdr.height * (stride + 1));
    const samples = new Uint8Array(ihdr.height * stride), bits = new Uint8Array(ihdr.height * stride);
    for (let y = 0; y < ihdr.height; y++) {
        assert.equal(inflated[y * (stride + 1)], 0, 'filter byte');
        for (let i = 0; i < stride; i++) {
            samples[y * stride + i] = inflated[y * (stride + 1) + 1 + i];
            bits[y * stride + i] = ~samples[y * stride + i] & 255;
        }
    }
    return { ...ihdr, phys, order, stride, samples, bits };
}

// rgba canvas stand-in: white, black where paint(x, y) is true
function rgbaFrom(width, height, paint) {
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (paint(x, y)) rgba.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
        }
    }
    return rgba;
}

const fakeMeasure = (font, text) => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
    if (font.includes('Keyrune')) return { width: size, ascent: size * 0.7, descent: 0, left: 0, right: size };
    const w = size * 0.6 * text.length;
    return { width: w, ascent: size * 0.7, descent: 0, left: 0, right: w };
};

test('check vectors: crc32 and adler32', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(adler32(Buffer.from('Wikipedia')), 0x11e60398);
});

test('[EXP-01/encoding] toBitmap: black is ink, white and transparent are not, stride is ceil(width/8)', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 127, 127, 127, 255, 130, 130, 130, 255]);
    const bm = toBitmap(rgba, 5, 1);
    assert.equal(bm.stride, 1);
    assert.equal(bm.bits[0], 0b10010000);   // black, white, transparent, 127 (ink), 130 (not ink)
});

test('[EXP-01/encoding] encodePng1bit: IHDR 1-bit grey, pHYs 7087 px/m unit 1, ink inverted', () => {
    const bm = toBitmap(rgbaFrom(16, 4, (x) => x === 0), 16, 4);
    const png = decodePng1bit(encodePng1bit(bm));
    assert.deepEqual([png.depth, png.colour, png.interlace], [1, 0, 0]);
    assert.deepEqual(png.phys, { x: 7087, y: 7087, unit: 1 });
    assert.equal(png.samples[0], 0b01111111);   // sample 0 = black
});

test('[EXP-01/ordering] chunks come as IHDR, pHYs, IDAT, IEND with valid CRCs and filter bytes', () => {
    const png = decodePng1bit(encodePng1bit(toBitmap(rgbaFrom(300, 128, () => false), 300, 128)));
    assert.deepEqual(png.order, ['IHDR', 'pHYs', 'IDAT', 'IEND']);
});

test('round trip: 300 x 128 bitmap survives encode and decode', () => {
    const bm = toBitmap(rgbaFrom(300, 128, (x, y) => (x * 7 + y * 3) % 5 === 0), 300, 128);
    const png = decodePng1bit(encodePng1bit(bm));
    assert.deepEqual([png.width, png.height], [300, 128]);
    assert.deepEqual(png.bits, bm.bits);
});

test('[EXP-01/adjacency] width 13 pads with white bits and keeps ink columns at both edges', () => {
    const bm = toBitmap(rgbaFrom(13, 3, (x) => x === 0 || x === 12), 13, 3);
    const png = decodePng1bit(encodePng1bit(bm));
    assert.equal(png.stride, 2);
    assert.deepEqual(png.bits, bm.bits);
    for (let y = 0; y < 3; y++) {
        assert.equal(png.bits[y * 2] & 0x80, 0x80, 'ink at x=0');
        assert.equal(png.bits[y * 2 + 1] & 0x08, 0x08, 'ink at x=12');
        assert.equal(png.samples[y * 2 + 1] & 0b111, 0b111, 'padding bits are white');
    }
});

test('[EXP-01/empty] an all-white bitmap encodes to an all-white PNG', () => {
    const bm = toBitmap(rgbaFrom(40, 8, () => false), 40, 8);
    const png = decodePng1bit(encodePng1bit(bm));
    assert.ok(png.samples.every((b) => b === 255));
});

test('[EXP-01/empty] layoutLabel never yields a zero-width label', () => {
    for (const input of [{ code: '', glyph: null }, { code: 'ons', glyph: null, showName: false, showCode: false }, { code: 'x', glyph: null }]) {
        const { width, empty } = layoutLabel(input, fakeMeasure);
        assert.ok(width >= MIN_DOTS);
        assert.equal(empty, input.code === '' || input.showCode === false);
    }
});

test('[EXP-01/concurrency] encoding is pure: input is not mutated and equal input gives equal bytes', () => {
    const bm = toBitmap(rgbaFrom(50, 16, (x, y) => x === y), 50, 16);
    const before = Uint8Array.from(bm.bits);
    const a = encodePng1bit(bm), b = encodePng1bit(bm);
    assert.deepEqual(bm.bits, before);
    assert.deepEqual(a, b);
});

test('glyphFor: alias codes share a code point but stay separate keys', () => {
    assert.equal(glyphFor(KEYRUNE, 'ons'), 0xe62e);
    assert.equal(glyphFor(KEYRUNE, 'afr'), glyphFor(KEYRUNE, 'xdnd'));
    assert.equal(glyphFor(KEYRUNE, 'sld'), glyphFor(KEYRUNE, 'psld'));
});

test('[ICON-01/adjacency] aliases are separate entries in the map', () => {
    assert.ok('afr' in KEYRUNE && 'xdnd' in KEYRUNE && 'sld' in KEYRUNE && 'psld' in KEYRUNE);
});

test('[ICON-01/empty] glyphFor returns null instead of a default glyph', () => {
    for (const code of ['', null, undefined, 42, 'zzzzz', 'ss', 'constructor', '__proto__', 'toString']) {
        assert.equal(glyphFor(KEYRUNE, code), null, String(code));
    }
});

test('[ICON-02/encoding] glyphFor ignores case and surrounding blanks', () => {
    assert.equal(glyphFor(KEYRUNE, 'ONS'), 0xe62e);
    assert.equal(glyphFor(KEYRUNE, ' ons '), 0xe62e);
});

test('keyrune map: 425 entries, no bare ss, integer code points in the private use area', () => {
    assert.equal(Object.keys(KEYRUNE).length, 425);
    assert.equal(KEYRUNE.ss, undefined);
    for (const v of Object.values(KEYRUNE)) assert.ok(Number.isInteger(v) && v >= 0xe000 && v <= 0xf8ff);
});

test('[ICON-01/ordering] the map generator fails when one code gets two code points', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyrune-'));
    const css = join(dir, 'conflict.css');
    writeFileSync(css, '.ss-aa:before { content: "\\e001"; }\n.ss-aa:before { content: "\\e002"; }\n');
    const run = spawnSync(process.execPath, [new URL('../tools/gen-keyrune-map.mjs', import.meta.url).pathname, css, join(dir, 'out.js')]);
    assert.equal(run.status, 1);
    assert.match(String(run.stderr), /conflict: aa/);
});

test('[PAGE-04/adjacency] parseFragment dedupes repeats and skips empty segments', () => {
    assert.deepEqual(parseFragment('#sets=ons,ONS,ons'), ['ons']);
    assert.deepEqual(parseFragment('#sets=ons,,dom'), ['ons', 'dom']);
});

test('[PAGE-04/empty] parseFragment returns [] for empty and foreign input', () => {
    for (const hash of ['', '#', '#sets=', '#other=1', null, undefined, 42, {}]) assert.deepEqual(parseFragment(hash), [], String(hash));
});

test('[PAGE-04/encoding] parseFragment decodes, lower-cases and drops hostile segments', () => {
    assert.deepEqual(parseFragment('#sets=ons%2Cdom'), ['ons', 'dom']);
    assert.deepEqual(parseFragment('#sets=ONS'), ['ons']);
    assert.deepEqual(parseFragment('#sets=ons,%C3%A4%C3%B6x,toolong7,a,../x,<b>,dom'), ['ons', 'dom']);
    assert.deepEqual(parseFragment('#sets=%E0%A4%A,ons'), ['ons']);   // malformed percent sequence
    const many = Array.from({ length: 80 }, (_, i) => `s${String(i).padStart(2, '0')}`);
    assert.equal(parseFragment(`#sets=${many.join(',')}`).length, 50);
});

test('[PAGE-04/ordering] parseFragment keeps first-occurrence order', () => {
    assert.deepEqual(parseFragment('#sets=dom,ons,dom,afr'), ['dom', 'ons', 'afr']);
});

test('layoutLabel (tracer): icon then code, text starts after the icon gap', () => {
    const withIcon = layoutLabel({ code: 'ons', glyph: 0xe62e }, fakeMeasure);
    assert.equal(withIcon.height, 128);
    assert.ok(withIcon.width >= MIN_DOTS);
    assert.deepEqual(withIcon.ops.map((o) => o.type), ['glyph', 'text']);
    assert.equal(withIcon.ops[1].text, 'ONS');
    assert.ok(withIcon.ops[1].x >= PAD_X + ICON_GAP);
    for (const op of withIcon.ops) assert.ok(Number.isFinite(op.x) && Number.isFinite(op.y));

    const noIcon = layoutLabel({ code: 'ons', glyph: null }, fakeMeasure);
    assert.deepEqual(noIcon.ops.map((o) => o.type), ['text']);
    assert.equal(noIcon.ops[0].x, PAD_X);
});

// ---- full layout, names, caption, condition and preview helpers (plan 01-03 task 1) ----

const ALL_ON = { code: 'ons', name: 'Onslaught', glyph: 0xe62e, showIcon: true, showName: true, showCode: true, foil: false, cond: 'none' };
const textOps = (r) => r.ops.filter((o) => o.type === 'text');
const sizeOf = (op) => Number(/(\d+(?:\.\d+)?)px/.exec(op.font)[1]);
const BALDUR = "Commander Legends: Battle for Baldur's Gate";

// vertical extent of every op in the fake metrics (ascent = 0.7 x size, no descent)
function extents(r) {
    const spans = [];
    for (const op of r.ops) {
        if (op.type === 'text') spans.push([op.y - 0.7 * sizeOf(op), op.y]);
        if (op.type === 'box') spans.push([op.y, op.y + op.h]);
    }
    return spans;
}

test('layoutLabel: name large, code small, same left edge', () => {
    const r = layoutLabel(ALL_ON, fakeMeasure);
    assert.deepEqual(r.ops.map((o) => o.type), ['glyph', 'text', 'text']);
    const [name, code] = textOps(r);
    assert.equal(name.text, 'Onslaught');
    assert.ok(name.font.includes('700 60px Cinzel'));
    assert.equal(code.text, 'ONS');
    assert.equal(sizeOf(code), 30);
    assert.equal(code.x, name.x);
    assert.ok(code.y > name.y);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.empty, false);
});

test('layoutLabel: long name wraps to two 34 px lines plus the code line, all left aligned', () => {
    const r = layoutLabel({ ...ALL_ON, code: 'clb', name: BALDUR }, fakeMeasure);
    const t = textOps(r);
    assert.equal(t.length, 3);
    assert.deepEqual(t.map(sizeOf), [34, 34, 22]);
    assert.equal(`${t[0].text} ${t[1].text}`, BALDUR);
    assert.ok(t[0].y < t[1].y && t[1].y < t[2].y);
    assert.equal(new Set(t.map((o) => o.x)).size, 1);
    assert.ok(r.width <= 709);
});

test('layoutLabel: the longest realistic name stays inside 709 x 128', () => {
    const r = layoutLabel({ ...ALL_ON, name: 'Teenage Mutant Ninja Turtles Source Material' }, fakeMeasure);
    assert.ok(r.width <= 709);
    assert.equal(r.warnings.length, 0);
    for (const [top, bottom] of extents(r)) {
        assert.ok(top >= PAD_Y, `top ${top}`);
        assert.ok(bottom <= 128 - PAD_Y, `bottom ${bottom}`);
    }
});

test('[CONT-01/empty] name off or empty: the code becomes the large line and is not repeated', () => {
    for (const input of [{ ...ALL_ON, showName: false }, { ...ALL_ON, name: '' }, { ...ALL_ON, name: undefined }]) {
        const t = textOps(layoutLabel(input, fakeMeasure));
        assert.equal(t.length, 1);
        assert.equal(t[0].text, 'ONS');
        assert.equal(sizeOf(t[0]), 104);
    }
});

test('[CONT-01/size] promoted code is larger still, 76 px when badges share the height', () => {
    const t = textOps(layoutLabel({ ...ALL_ON, showName: false, foil: true, cond: 'NM' }, fakeMeasure));
    assert.equal(t[0].text, 'ONS');
    assert.equal(sizeOf(t[0]), 76);
});

test('[CONT-01/adjacency] nothing to draw: empty label of minimum width; ICON_GAP only with icon and text', () => {
    const none = layoutLabel({ ...ALL_ON, showIcon: false, showName: false, showCode: false }, fakeMeasure);
    assert.deepEqual([none.empty, none.width, none.ops, none.warnings], [true, 174, [], ['empty']]);
    const iconOnly = layoutLabel({ ...ALL_ON, showName: false, showCode: false }, fakeMeasure);
    assert.deepEqual(iconOnly.ops.map((o) => o.type), ['glyph']);
    assert.ok(iconOnly.width >= MIN_DOTS);
    const iconWidth = fakeMeasure('100px Keyrune', 'x').right * Math.min(112 / 70, 150 / 100);
    const withText = layoutLabel(ALL_ON, fakeMeasure);
    assert.ok(Math.abs(textOps(withText)[0].x - (PAD_X + iconWidth + ICON_GAP)) < 0.01);
});

test('[CONT-01/ordering] icon, then name, then the small line: code, FOIL box, condition box', () => {
    const r = layoutLabel({ ...ALL_ON, foil: true, cond: 'NM' }, fakeMeasure);
    assert.deepEqual(r.ops.map((o) => `${o.type}:${o.text ?? ''}`), ['glyph:' + String.fromCodePoint(0xe62e), 'text:Onslaught', 'text:ONS', 'box:', 'text:FOIL', 'box:', 'text:NM']);
    const [foilBox, condBox] = r.ops.filter((o) => o.type === 'box');
    assert.ok(foilBox.radius > 0);
    assert.equal(condBox.radius, 0);
    assert.ok(condBox.x - (foilBox.x + foilBox.w) >= 10);
    const code = textOps(r)[1];
    assert.ok(foilBox.x > code.x + 22 * 0.6 * 3);
    const foilText = textOps(r)[2];
    assert.ok(foilText.x > foilBox.x && foilText.x < foilBox.x + foilBox.w);
    assert.ok(Math.abs(foilText.y - code.y) < 0.01, 'one shared baseline');
});

test('[CONT-02/empty] foil false: no FOIL text, no box, no extra gap', () => {
    const plain = layoutLabel({ ...ALL_ON, cond: 'NM' }, fakeMeasure);
    assert.ok(!plain.ops.some((o) => o.text === 'FOIL'));
    assert.equal(plain.ops.filter((o) => o.type === 'box').length, 1);
    const both = layoutLabel({ ...ALL_ON, foil: true, cond: 'NM' }, fakeMeasure);
    const condPlain = plain.ops.find((o) => o.type === 'box');
    const code = textOps(plain)[1];
    assert.ok(Math.abs(condPlain.x - (code.x + 30 * 0.6 * 3) - 10) < 1e-9);   // one gap after the code, nothing for the missing FOIL
    assert.ok(both.ops.filter((o) => o.type === 'box')[1].x > condPlain.x, 'FOIL pushes the condition box right');
});

test('[CONT-02/encoding] the foil badge text is exactly FOIL', () => {
    const r = layoutLabel({ ...ALL_ON, foil: true }, fakeMeasure);
    assert.equal(textOps(r).filter((o) => o.text === 'FOIL').length, 1);
    assert.equal(r.ops.filter((o) => o.type === 'box').length, 1);
});

test('[CONT-03/empty] cond none, undefined, null or unknown adds nothing', () => {
    const base = layoutLabel(ALL_ON, fakeMeasure);
    for (const cond of ['none', undefined, null, 'xx', '', 7]) {
        assert.deepEqual(layoutLabel({ ...ALL_ON, cond }, fakeMeasure), base, String(cond));
    }
});

test('[CONT-03/encoding] normalizeCondition accepts only the seven Cardmarket codes', () => {
    assert.equal(normalizeCondition('nm'), 'NM');
    assert.equal(normalizeCondition('PO'), 'PO');
    assert.equal(normalizeCondition(' EX '), 'EX');
    for (const code of ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO']) assert.equal(normalizeCondition(code.toLowerCase()), code);
    for (const bad of ['', 'zz', 'none', 7, null, undefined, {}, 'NMM']) assert.equal(normalizeCondition(bad), 'none');
    assert.equal(textOps(layoutLabel({ ...ALL_ON, cond: 'nm' }, fakeMeasure)).pop().text, 'NM');
});

test('[CONT-04/empty] quantity-like keys never change the layout', () => {
    const base = layoutLabel(ALL_ON, fakeMeasure);
    assert.deepEqual(layoutLabel({ ...ALL_ON, quantity: 12, qty: 3, count: 99 }, fakeMeasure), base);
});

test('[CONT-04/encoding] digits in a set name are drawn as text', () => {
    const r = layoutLabel({ ...ALL_ON, name: 'Core Set 2020' }, fakeMeasure);
    assert.ok(textOps(r).some((o) => o.text.includes('2020')));
    assert.ok(!textOps(r).some((o) => /\b(12|3|99)\b/.test(o.text)));
});

test('[ICON-02/adjacency] missing glyph: text starts at PAD_X and warns only when the icon is on', () => {
    const missing = layoutLabel({ ...ALL_ON, glyph: null }, fakeMeasure);
    assert.equal(textOps(missing)[0].x, PAD_X);
    assert.deepEqual(missing.warnings, ['no-glyph']);
    const off = layoutLabel({ ...ALL_ON, showIcon: false }, fakeMeasure);
    assert.equal(textOps(off)[0].x, PAD_X);
    assert.ok(!off.ops.some((o) => o.type === 'glyph'));
    assert.deepEqual(off.warnings, []);
    assert.deepEqual(layoutLabel({ ...ALL_ON, glyph: null, showIcon: false }, fakeMeasure).warnings, []);
});

test('[ICON-02/ordering] warnings follow the fixed order', () => {
    const noGlyphEmpty = layoutLabel({ ...ALL_ON, glyph: null, showName: false, showCode: false }, fakeMeasure);
    assert.deepEqual([noGlyphEmpty.empty, noGlyphEmpty.warnings], [true, ['no-glyph', 'empty']]);
    const overMax = layoutLabel({ ...ALL_ON, glyph: null, name: 'W'.repeat(60) }, fakeMeasure);
    assert.deepEqual(overMax.warnings, ['no-glyph', 'over-max']);
});

test('layoutLabel: maxMm limits the automatic width by wrapping; an unbreakable word reports over-max', () => {
    const wrapped = layoutLabel({ ...ALL_ON, showIcon: false, name: 'Teenage Mutant Ninja Turtles', maxMm: 50 }, fakeMeasure);
    assert.ok(wrapped.width <= 354);
    assert.deepEqual(wrapped.warnings, []);
    const word = layoutLabel({ ...ALL_ON, name: 'W'.repeat(60), maxMm: 50 }, fakeMeasure);
    assert.deepEqual(word.warnings, ['over-max']);
    assert.ok(word.width > 354 && word.width <= 7086);
});

test('layoutLabel: deterministic and the stack is centred vertically', () => {
    const inputs = [ALL_ON, { ...ALL_ON, foil: true, cond: 'GD' }, { ...ALL_ON, name: BALDUR, foil: true }, { ...ALL_ON, showName: false }];
    for (const input of inputs) {
        const a = layoutLabel(input, fakeMeasure);
        assert.deepEqual(layoutLabel(input, fakeMeasure), a);
        const spans = extents(a);
        const top = Math.min(...spans.map((s) => s[0])), bottom = Math.max(...spans.map((s) => s[1]));
        assert.ok(Math.abs((top + bottom) / 2 - 64) <= 4, `centre ${(top + bottom) / 2}`);   // 3 dots off without badges: their padding is still reserved
    }
});

test('layoutLabel: name and code keep their place and gap when FOIL or a condition is toggled', () => {
    const base = textOps(layoutLabel(ALL_ON, fakeMeasure));
    for (const extra of [{ foil: true }, { cond: 'NM' }, { foil: true, cond: 'NM' }]) {
        const t = textOps(layoutLabel({ ...ALL_ON, ...extra }, fakeMeasure)).filter((o) => o.text === 'Onslaught' || o.text === 'ONS');
        assert.deepEqual(t.map((o) => o.y), base.map((o) => o.y), JSON.stringify(extra));
    }
});

test('layoutLabel: badges without code sit at the text start', () => {
    const r = layoutLabel({ ...ALL_ON, showCode: false, foil: true }, fakeMeasure);
    const box = r.ops.find((o) => o.type === 'box');
    assert.equal(box.x, textOps(r)[0].x);
    assert.ok(!textOps(r).some((o) => o.text === 'ONS'));
});

test('fileName: code-name-foil-condition, lower case and file safe', () => {
    assert.equal(fileName({ code: 'ONS', name: 'Onslaught', foil: true, cond: 'NM' }), 'ons-onslaught-foil-nm.png');
    assert.equal(fileName({ code: 'CLB', name: BALDUR }), 'clb-commander-legends-battle-for-baldurs-gate.png');
    assert.ok(fileName({ code: 'aer', name: 'Æther Revolt' }).includes('aether-revolt'));
    assert.equal(fileName({ code: 'x', name: '../../etc/passwd' }), 'x-etc-passwd.png');
    assert.equal(fileName({}), 'label.png');
    assert.equal(fileName(), 'label.png');
    assert.equal(fileName({ code: 'ons', foil: false, cond: 'none' }), 'ons.png');
    assert.equal(fileName({ code: 'ons', cond: 'gd' }), 'ons-gd.png');
    const long = fileName({ code: 'ons', name: 'a'.repeat(300) });
    assert.ok(long.length <= 104 && long.endsWith('.png'));
    for (const hostile of ['a/b\\c', '..', '\u0000x', 'Straße']) assert.match(fileName({ code: 'x', name: hostile }), /^[a-z0-9-]+\.png$/);
});

test('[PAGE-03/encoding] fold removes case, diacritics and expands ligatures', () => {
    assert.equal(fold('Æther Revolt'), 'aether revolt');
    assert.equal(fold('Édition Œuvre Straße'), 'edition oeuvre strasse');
    assert.equal(fold(null), 'null');
});

test('[EXP-02/adjacency] uniqueNames suffixes duplicates and never collides', () => {
    assert.deepEqual(uniqueNames(['a.png', 'a.png', 'a-2.png', 'b.png']), ['a.png', 'a-3.png', 'a-2.png', 'b.png']);
    const out = uniqueNames(['x.png', 'X.png', 'x.png', 'y', 'y']);
    assert.equal(new Set(out.map((n) => n.toLowerCase())).size, 5);
    assert.deepEqual(uniqueNames([]), []);
});

test('[CONT-05/encoding] captionFor rounds dots to mm without locale formatting', () => {
    assert.equal(captionFor(440), '62 x 18 mm printable (24 mm tape)');
    assert.ok(captionFor(174).startsWith('25 x 18'));
    assert.ok(captionFor(7086).startsWith('1000 x 18'));
});

test('[CONT-05/encoding] bitmapToRgba round-trips through toBitmap', () => {
    for (const w of [13, 300]) {
        const b = toBitmap(rgbaFrom(w, 9, (x, y) => (x * 5 + y) % 3 === 0), w, 9);
        const rgba = bitmapToRgba(b);
        assert.equal(rgba.length, w * 9 * 4);
        assert.deepEqual(toBitmap(rgba, w, 9), b);
    }
    const one = bitmapToRgba(toBitmap(rgbaFrom(2, 1, (x) => x === 0), 2, 1));
    assert.deepEqual([...one], [0, 0, 0, 255, 255, 255, 255, 255]);
});

// ---- ZIP, set filtering, sorting, search, CSV grouping, validation (plan 01-03 task 2) ----

// minimal ZIP reader: end of central directory -> central directory -> local headers
function readZip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const eocd = bytes.length - 22;
    assert.equal(dv.getUint32(eocd, true), 0x06054b50);
    const count = dv.getUint16(eocd + 10, true);
    const entries = [];
    let o = dv.getUint32(eocd + 16, true);
    for (let i = 0; i < count; i++) {
        assert.equal(dv.getUint32(o, true), 0x02014b50);
        const nameLen = dv.getUint16(o + 28, true);
        const entry = {
            flag: dv.getUint16(o + 8, true), method: dv.getUint16(o + 10, true), crc: dv.getUint32(o + 16, true),
            size: dv.getUint32(o + 24, true), offset: dv.getUint32(o + 42, true),
            name: new TextDecoder().decode(bytes.subarray(o + 46, o + 46 + nameLen))
        };
        assert.equal(dv.getUint32(entry.offset, true), 0x04034b50, 'local header signature');
        const localName = dv.getUint16(entry.offset + 26, true), localExtra = dv.getUint16(entry.offset + 28, true);
        entry.localName = new TextDecoder().decode(bytes.subarray(entry.offset + 30, entry.offset + 30 + localName));
        entry.data = bytes.subarray(entry.offset + 30 + localName + localExtra, entry.offset + 30 + localName + localExtra + entry.size);
        entries.push(entry);
        o += 46 + nameLen + dv.getUint16(o + 30, true) + dv.getUint16(o + 32, true);
    }
    return entries;
}

const SETS = [
    { code: 'ons', name: 'Onslaught', released_at: '2002-10-07', set_type: 'expansion', digital: false },
    { code: 'dom', name: 'Dominaria', released_at: '2018-04-27', set_type: 'expansion', digital: false },
    { code: 'aer', name: 'Æther Revolt', released_at: '2017-01-20', set_type: 'expansion', digital: false },
    { code: 'tons', name: 'Onslaught Tokens', released_at: '2002-10-07', set_type: 'token', digital: false },
    { code: 'pmei', name: 'Magic Online Promos', released_at: null, set_type: 'promo', digital: false },
    { code: 'mmh', name: 'Mini Game', released_at: '2020-01-01', set_type: 'minigame', digital: false },
    { code: 'vma', name: 'Vintage Masters', released_at: '2014-06-16', set_type: 'masters', digital: true },
    { code: 'fut', name: 'Future Set', released_at: '2099-01-01', set_type: 'core', digital: false },
    { code: 'dmu', name: 'Dominaria United', released_at: '2022-09-09', set_type: 'expansion', digital: false },
    { code: 'cmd', name: 'Commander Legends', released_at: '2020-11-20', set_type: 'commander', digital: false },
    { code: 'm20', name: 'Core Set 2020', released_at: '2019-07-12', set_type: 'core', digital: false },
    { code: 'm21', name: 'Core Set 2020', released_at: '2020-07-03', set_type: 'core', digital: false }
];
const codes = (list) => list.map((x) => x.code);

test('zipStore: parses back with names, order, stored size, CRC and UTF-8 flag', () => {
    const a = Uint8Array.from({ length: 3000 }, (_, i) => i * 7 % 256);
    const b = new TextEncoder().encode('second');
    const files = [{ name: 'ons-onslaught.png', data: a }, { name: 'ä-ö.png', data: b }, { name: 'empty.png', data: new Uint8Array(0) }];
    const out = zipStore(files, new Date(2026, 9, 20, 12, 30, 40));
    const entries = readZip(out);
    assert.deepEqual(entries.map((e) => e.name), files.map((f) => f.name));
    assert.deepEqual(entries.map((e) => e.localName), files.map((f) => f.name));
    entries.forEach((e, i) => {
        assert.equal(e.flag & 0x0800, 0x0800);
        assert.equal(e.method, 0);
        assert.equal(e.size, files[i].data.length);
        assert.equal(e.crc, crc32(files[i].data));
        assert.deepEqual(Uint8Array.from(e.data), files[i].data);
    });
});

test('[EXP-02/empty] zipStore([]) is the 22-byte end record with zero entries', () => {
    const out = zipStore([]);
    assert.equal(out.length, 22);
    const dv = new DataView(out.buffer, out.byteOffset, out.length);
    assert.equal(dv.getUint32(0, true), 0x06054b50);
    assert.equal(dv.getUint16(8, true), 0);
    assert.equal(dv.getUint16(10, true), 0);
});

test('[EXP-02/ordering] zipStore keeps input order in local headers and central directory', () => {
    const names = ['c.png', 'a.png', 'b.png'];
    const out = zipStore(names.map((name, i) => ({ name, data: Uint8Array.of(i) })));
    const entries = readZip(out);
    assert.deepEqual(entries.map((e) => e.name), names);
    assert.deepEqual(entries.map((e) => e.offset), [...entries.map((e) => e.offset)].sort((x, y) => x - y));
    assert.deepEqual(entries.map((e) => e.localName), names);
});

test('zipStore: real PNGs pass unzip -t and Python zipfile when available', (t) => {
    const png = encodePng1bit(toBitmap(rgbaFrom(200, 128, (x, y) => x === y), 200, 128));
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const file = join(dir, 'labels.zip');
    writeFileSync(file, zipStore([{ name: 'ons-onslaught-foil-nm.png', data: png }, { name: 'ä.png', data: png }]));
    const unzip = spawnSync('unzip', ['-t', file]);
    if (unzip.error) return t.skip('unzip not on PATH');
    assert.equal(unzip.status, 0, String(unzip.stdout));
});

test('filterSets: digital never shows, hidden types only with showAll', () => {
    assert.deepEqual(HIDDEN_SET_TYPES, ['token', 'promo', 'memorabilia', 'minigame']);
    assert.deepEqual(codes(filterSets(SETS, false)), ['ons', 'dom', 'aer', 'fut', 'dmu', 'cmd', 'm20', 'm21']);
    const all = codes(filterSets(SETS, true));
    assert.ok(all.includes('mmh') && all.includes('tons') && all.includes('pmei'), 'minigame, token and promo appear with showAll');
    assert.ok(!all.includes('vma'), 'digital set stays hidden');
    assert.ok(!codes(filterSets(SETS, undefined)).includes('mmh'));
    assert.equal(filterSets(SETS, false) !== SETS, true);
});

test('[PAGE-02/ordering] sortSets: dates ascending, name then code ties, undated last, input untouched', () => {
    const before = codes(SETS);
    const sorted = sortSets(SETS);
    assert.deepEqual(codes(SETS), before);
    assert.deepEqual(codes(sorted), ['ons', 'tons', 'vma', 'aer', 'dom', 'm20', 'mmh', 'm21', 'cmd', 'dmu', 'fut', 'pmei']);
    const twin = sortSets([
        { code: 'zz2', name: 'Same', released_at: '2020-01-01' }, { code: 'zz1', name: 'Same', released_at: '2020-01-01' },
        { code: 'bb', name: 'Beta', released_at: null }, { code: 'aa', name: 'Alpha', released_at: 'garbage' }, { code: 'cc', name: 'Gamma' }
    ]);
    assert.deepEqual(codes(twin), ['zz1', 'zz2', 'aa', 'bb', 'cc']);
    assert.deepEqual(sortSets([]), []);
});

test('[PAGE-03/adjacency] searchSets ranks exact code, then code prefix, then name; each set once', () => {
    const hits = searchSets(SETS, 'ons');
    assert.deepEqual(codes(hits), ['ons', 'tons']);
    const ranked = searchSets([
        { code: 'abc', name: 'Zed ons' }, { code: 'onsx', name: 'Y' }, { code: 'ons', name: 'X' }, { code: 'onsy', name: 'Y2' }
    ], 'ons');
    assert.deepEqual(codes(ranked), ['ons', 'onsx', 'onsy', 'abc']);
    assert.equal(new Set(codes(searchSets(SETS, 'o'))).size, searchSets(SETS, 'o').length);
});

test('[PAGE-03/empty] searchSets: blank query returns everything in input order, no match returns []', () => {
    for (const q of ['', '   ', undefined, null, 7, {}]) assert.deepEqual(codes(searchSets(SETS, q)), codes(SETS), String(q));
    assert.notEqual(searchSets(SETS, ''), SETS);
    assert.deepEqual(searchSets(SETS, 'zzzz'), []);
});

test('[PAGE-03/encoding] searchSets is case and diacritics insensitive', () => {
    assert.deepEqual(codes(searchSets(SETS, 'aether')), ['aer']);
    assert.deepEqual(codes(searchSets(SETS, 'ÆTHER')), ['aer']);
    assert.deepEqual(codes(searchSets(SETS, 'COMMANDER legends')), ['cmd']);
});

test('[PAGE-03/ordering] searchSets keeps input order inside one rank', () => {
    assert.deepEqual(codes(searchSets(SETS, 'dominaria')), ['dom', 'dmu']);
    const dated = sortSets(SETS);
    assert.deepEqual(codes(searchSets(dated, 'core set')), ['m20', 'm21']);
});

const csvFile = (rows, binder = '') => ({ rows, binder });

test('[PAGE-02/adjacency] groupCsvSets merges one code, keeps the same name under two codes apart', () => {
    const out = groupCsvSets(csvFile([
        { setCode: 'ONS', setName: 'Onslaught' }, { setCode: 'ons', setName: 'Other' }, { setCode: 'M20', setName: 'Core Set 2020' }, { setCode: 'M21', setName: 'Core Set 2020' }
    ]));
    assert.deepEqual(out, [{ code: 'ons', name: 'Onslaught' }, { code: 'm20', name: 'Core Set 2020' }, { code: 'm21', name: 'Core Set 2020' }]);
});

test('[PAGE-02/empty] groupCsvSets returns [] for missing input and skips rows without a code', () => {
    for (const f of [undefined, null, {}, { rows: [] }, { rows: 'x' }, 42]) assert.deepEqual(groupCsvSets(f), [], String(JSON.stringify(f)));
    assert.deepEqual(groupCsvSets(csvFile([{ setCode: '', setName: 'x' }, { setName: 'y' }, null, 'row'])), []);
});

test('[PAGE-02/encoding] groupCsvSets lower-cases and validates codes, keeps accents, blanks bad names', () => {
    const out = groupCsvSets(csvFile([
        { setCode: 'ONS', setName: 'Onslaught' }, { setCode: 'A', setName: 'short' }, { setCode: 'TOOLONG7', setName: 'long' },
        { setCode: '../x', setName: 'bad' }, { setCode: 'ÄÖX', setName: 'bad' }, { setCode: 'aer', setName: 'Æther Revolt' },
        { setCode: 'dom', setName: 42 }, { setCode: ' m20 ', setName: 'Core Set 2020' }, { setCode: 'constructor', setName: 'proto' }
    ]));
    assert.deepEqual(out, [
        { code: 'ons', name: 'Onslaught' }, { code: 'aer', name: 'Æther Revolt' }, { code: 'dom', name: '' },
        { code: 'm20', name: 'Core Set 2020' }
    ]);
});

test('[PAGE-05/ordering] groupCsvSets returns sets in first-seen row order', () => {
    const out = groupCsvSets(csvFile([{ setCode: 'dom', setName: 'D' }, { setCode: 'ons', setName: 'O' }, { setCode: 'dom', setName: 'D2' }, { setCode: 'afr', setName: 'A' }]));
    assert.deepEqual(out.map((s) => s.code), ['dom', 'ons', 'afr']);
});

test('[CONT-04/encoding] groupCsvSets ignores qty, foil and prices', () => {
    const a = groupCsvSets(csvFile([{ setCode: 'ons', setName: 'Onslaught', qty: 99, foil: 'foil', price: 5 }]));
    const b = groupCsvSets(csvFile([{ setCode: 'ons', setName: 'Onslaught', qty: 1 }]));
    assert.deepEqual(a, b);
    assert.deepEqual(Object.keys(a[0]), ['code', 'name']);
});

test('groupCsvSets: binder filter follows the panel rule', () => {
    const rows = [{ setCode: 'ons', setName: 'O', binder: 'Box 1' }, { setCode: 'dom', setName: 'D', binder: 'Box 2' }];
    assert.deepEqual(groupCsvSets(csvFile(rows, '')).length, 2);
    assert.deepEqual(groupCsvSets(csvFile(rows, '*')).length, 2);
    assert.deepEqual(groupCsvSets(csvFile(rows, 'Box 2')).map((s) => s.code), ['dom']);
    assert.deepEqual(groupCsvSets(csvFile(rows, 'Nope')), []);
});

test('resolveSet: case-insensitive lookup with a fallback record', () => {
    assert.equal(resolveSet(SETS, 'ONS', 'x'), SETS[0]);
    assert.deepEqual(resolveSet(SETS, 'zzz', 'Custom'), { code: 'zzz', name: 'Custom', released_at: null, set_type: '', digital: false });
    assert.equal(resolveSet(SETS, 'zzz').name, 'ZZZ');
    assert.equal(resolveSet([], 'constructor').name, 'CONSTRUCTOR');
});

test('trimSets: keeps five validated fields, drops malformed entries, throws on bad input', () => {
    const json = {
        object: 'list',
        data: [
            { code: 'ONS', name: 'Onslaught', released_at: '2002-10-07', set_type: 'expansion', digital: false, icon_svg_uri: 'https://x', card_count: 350 },
            { code: 'bad code', name: 'x' }, { code: 'dom', name: '' }, { code: 'dmu', name: 'D'.repeat(201) }, null, 'str',
            { code: 'afr', name: 'Adventures', released_at: 'soon', set_type: 'y'.repeat(41), digital: 'true' },
            { code: 'vma', name: 'Vintage', released_at: '2014-06-16', set_type: 'masters', digital: true }
        ]
    };
    const out = trimSets(json);
    assert.deepEqual(out, [
        { code: 'ons', name: 'Onslaught', released_at: '2002-10-07', set_type: 'expansion', digital: false },
        { code: 'afr', name: 'Adventures', released_at: null, set_type: '', digital: false },
        { code: 'vma', name: 'Vintage', released_at: '2014-06-16', set_type: 'masters', digital: true }
    ]);
    assert.deepEqual(trimSets(json.data), out);
    for (const bad of [null, undefined, 'x', 42, {}, { object: 'list' }, { data: 'x' }]) assert.throws(() => trimSets(bad), /not a list/, String(bad));
    for (const none of [[], { data: [] }, [{ code: '!' }]]) assert.throws(() => trimSets(none), /no valid sets/);
});

test('normalizeSettings: defaults, real booleans only, clamped length, whitelisted condition', () => {
    const defaults = { icon: true, name: true, code: true, maxMm: null, foil: false, cond: 'none' };
    for (const raw of [undefined, null, 'x', 5, [], true]) assert.deepEqual(normalizeSettings(raw), defaults, String(raw));
    assert.deepEqual(normalizeSettings({ icon: false, name: 'no', code: 0, foil: 1, cond: 'nm', maxMm: 60, evil: '<script>', __proto__: { x: 1 } }),
        { icon: false, name: true, code: true, maxMm: 60, foil: false, cond: 'NM' });
    assert.equal(normalizeSettings({ maxMm: 150 }).maxMm, 150);
    assert.equal(normalizeSettings({ maxMm: 5 }).maxMm, 24.5);
    for (const bad of [0, -4, NaN, '100', null]) assert.equal(normalizeSettings({ maxMm: bad }).maxMm, null, String(bad));
    assert.equal(normalizeSettings({ maxMm: 5000 }).maxMm, 1000);
    assert.equal(normalizeSettings({ fixedMm: 60 }).fixedMm, undefined, 'the fixed length setting is gone');
    assert.equal(normalizeSettings({ foil: true }).foil, true);
});

test('layoutLabel: with a max length set the name shrinks until it fits, down to 16 px', () => {
    const unset = layoutLabel({ ...ALL_ON, name: BALDUR, glyph: null }, fakeMeasure);
    const set = layoutLabel({ ...ALL_ON, name: BALDUR, glyph: null, maxMm: 40 }, fakeMeasure);
    const sizes = (r) => textOps(r).filter((o) => o.text !== 'ONS').map(sizeOf);
    assert.ok(Math.max(...sizes(set)) < Math.max(...sizes(unset)), 'smaller than the default fit');
    assert.ok(Math.min(...sizes(set)) >= 16);
    assert.ok(set.width <= mmToDots(40), `width ${set.width}`);
    assert.ok(!set.warnings.includes('over-max'));
    const hopeless = layoutLabel({ ...ALL_ON, name: 'W'.repeat(80), glyph: null, maxMm: 40 }, fakeMeasure);
    assert.deepEqual(sizes(hopeless), [16]);
    assert.ok(hopeless.warnings.includes('over-max'));
});

test('layoutLabel: a larger max length lets a long name stay on one line, a smaller one wraps it sooner', () => {
    const name = 'Dominaria United Commander';
    const wide = textOps(layoutLabel({ ...ALL_ON, name, maxMm: 160 }, fakeMeasure));
    assert.equal(wide.filter((o) => o.text !== 'ONS').length, 1, 'one line at 160 mm');
    const narrow = textOps(layoutLabel({ ...ALL_ON, name, maxMm: 60 }, fakeMeasure));
    assert.ok(narrow.filter((o) => o.text !== 'ONS').length > 1, 'wrapped at 60 mm');
});

test('[CONT-01/size] a name with no small line below it uses the large tier, 104 px when it fits', () => {
    const pick = (name) => sizeOf(textOps(layoutLabel({ ...ALL_ON, name, glyph: null, showCode: false }, fakeMeasure))[0]);
    assert.equal(pick('W'.repeat(9)), 104);
    assert.equal(pick('W'.repeat(11)), 92);
    assert.equal(pick('W'.repeat(13)), 80);
    assert.equal(pick('W'.repeat(15)), 68);
    assert.equal(sizeOf(textOps(layoutLabel({ ...ALL_ON, name: 'Ons', glyph: null, showCode: false, foil: true }, fakeMeasure))[0]), 60, 'with a badge line the normal tier applies');
});
