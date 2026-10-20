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
const { crc32, adler32, toBitmap, encodePng1bit, glyphFor, parseFragment, layoutLabel, MIN_DOTS, PAD_X, ICON_GAP } = core;

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
    for (const input of [{ code: '', glyph: null }, { code: 'ons', glyph: null, showCode: false }, { code: 'x', glyph: null }]) {
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
