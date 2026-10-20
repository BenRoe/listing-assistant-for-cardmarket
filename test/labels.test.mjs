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
    normalizeCondition, fold, mmToDots, fileName, uniqueNames, captionFor, bitmapToRgba
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
    assert.ok(name.font.includes('700 44px Cinzel'));
    assert.equal(code.text, 'ONS');
    assert.equal(sizeOf(code), 22);
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
        assert.equal(sizeOf(t[0]), 44);
    }
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
    assert.ok(Math.abs(condPlain.x - (code.x + 22 * 0.6 * 3) - 10) < 1e-9);   // one gap after the code, nothing for the missing FOIL
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
    const overFixed = layoutLabel({ ...ALL_ON, glyph: null, name: 'W'.repeat(60), fixedMm: 30 }, fakeMeasure);
    assert.deepEqual(overFixed.warnings, ['no-glyph', 'overflow-fixed']);
});

test('layoutLabel: fixed length is exact, clamped, left aligned', () => {
    const short = { ...ALL_ON, name: 'Alara' };
    const auto = layoutLabel(short, fakeMeasure);
    const fixed = layoutLabel({ ...short, fixedMm: 60 }, fakeMeasure);
    assert.equal(fixed.width, 425);
    assert.equal(mmToDots(60), 425);
    assert.deepEqual(fixed.ops, auto.ops);
    assert.equal(layoutLabel({ ...short, fixedMm: 5 }, fakeMeasure).width, 174);
    assert.equal(layoutLabel({ ...short, fixedMm: 2000 }, fakeMeasure).width, 7086);
    const tight = layoutLabel({ ...ALL_ON, name: BALDUR, fixedMm: 30 }, fakeMeasure);
    assert.equal(tight.width, 213);
    assert.deepEqual(tight.warnings, ['overflow-fixed']);
    for (const bad of [0, -3, NaN, '60', null]) assert.equal(layoutLabel({ ...short, fixedMm: bad }, fakeMeasure).width, auto.width, String(bad));
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
        assert.ok(Math.abs((top + bottom) / 2 - 64) <= 2, `centre ${(top + bottom) / 2}`);
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
