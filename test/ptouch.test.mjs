import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../labels/ptouch.js');

const T = { reverseLines: false, reversePins: false };
const bytes = (...parts) => Uint8Array.from(parts.flat(Infinity));
const zeros = (n) => new Array(n).fill(0);

// width x 128 bitmap with ink at the given [x, y] points (1 = ink, MSB first, the Phase 1 contract)
function bitmap(width, points) {
    const stride = (width + 7) >> 3;
    const bits = new Uint8Array(stride * 128);
    for (const [x, y] of points) bits[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    return { width, height: 128, stride, bits };
}

const golden = bitmap(3, [[0, 0], [1, 127], [2, 8]]);
const head = (cutByte) => [
    zeros(100), [0x1b, 0x40], [0x1b, 0x69, 0x61, 0x01], [0x1b, 0x69, 0x21, 0x00],
    [0x1b, 0x69, 0x7a, 0x84, 0x00, 0x18, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00],
    [0x1b, 0x69, 0x4d, cutByte], [0x1b, 0x69, 0x4b, 0x08], [0x1b, 0x69, 0x64, 0x0e, 0x00], [0x4d, 0x00]
];
const goldenJob = (cutByte) => bytes(
    head(cutByte),
    [0x47, 0x10, 0x00, 0x80, ...zeros(15)],
    [0x47, 0x10, 0x00, ...zeros(15), 0x01],
    [0x47, 0x10, 0x00, 0x00, 0x80, ...zeros(14)],
    [0x1a]
);

test('[D-02/D-04] buildJob of the 3 column golden bitmap is the 196 reference bytes, cut on', () => {
    const job = P.buildJob(golden, { cut: true, orientation: T });
    assert.equal(job.length, 196);
    assert.deepEqual(Array.from(job), Array.from(goldenJob(0x40)));
});

test('[D-02/D-04] cut off differs only in the ESC i M value', () => {
    const on = P.buildJob(golden, { cut: true, orientation: T });
    const off = P.buildJob(golden, { cut: false, orientation: T });
    assert.deepEqual(Array.from(off), Array.from(goldenJob(0x00)));
    const diff = Array.from(on).flatMap((b, i) => (b === off[i] ? [] : [i]));
    assert.deepEqual(diff, [126]);
});

test('[D-12] the default margin is 14 dots (2 mm) and the printed length is lines plus 2 x FEED_DOTS', () => {
    assert.equal(P.FEED_DOTS, 14);
    const job = P.buildJob(golden, { orientation: T });
    assert.deepEqual(Array.from(job.subarray(131, 136)), [0x1b, 0x69, 0x64, 14, 0]);
    const wide = Array.from(P.buildJob(golden, { orientation: T, feedDots: 300 }).subarray(131, 136));
    assert.deepEqual(wide, [0x1b, 0x69, 0x64, 0x2c, 0x01]);
});

test('constants and exports', () => {
    assert.deepEqual([P.HEAD_BYTES, P.TAPE_DOTS, P.TAPE_MM, P.FEED_DOTS, P.MAX_LINES, P.INVALIDATE_LEN, P.STATUS_LEN], [16, 128, 24, 14, 7086, 100, 32]);
    for (const name of ['invalidate', 'init', 'statusRequest', 'rasterLines', 'buildJob', 'takeFrame', 'parseStatus', 'formatRaw', 'describeStatus', 'tapeMismatchText']) {
        assert.equal(typeof P[name], 'function', name);
    }
    assert.deepEqual(Array.from(P.invalidate()), zeros(100));
    assert.deepEqual(Array.from(P.init()), [0x1b, 0x40]);
    assert.deepEqual(Array.from(P.statusRequest()), [0x1b, 0x69, 0x53]);
});

test('[PRNT-02/encoding] ORIENTATION is the hardware-verified value (HW-1)', () => {
    assert.deepEqual(P.ORIENTATION, { reverseLines: false, reversePins: false });
});

test('[PRNT-02/encoding] rows 0, 7, 8, 127 and the first and last column land on the pinned bit', () => {
    const cases = [[0, 0, 0, 0x80], [3, 7, 0, 0x01], [8, 8, 1, 0x80], [8, 127, 15, 0x01], [0, 127, 15, 0x01], [0, 8, 1, 0x80]];
    for (const [x, y, byte, mask] of cases) {
        const lines = P.rasterLines(bitmap(9, [[x, y]]), T);
        assert.equal(lines.length, 9);
        lines.forEach((line, i) => {
            const expected = i === x ? Array.from({ length: 16 }, (_, b) => (b === byte ? mask : 0)) : zeros(16);
            assert.deepEqual(Array.from(line), expected, `x=${x} y=${y} line ${i}`);
        });
    }
});

test('[PRNT-02/encoding] ORIENTATION flips line order and pin order independently', () => {
    const bm = bitmap(5, [[0, 0], [1, 5], [2, 64], [3, 127], [4, 9]]);
    const base = P.rasterLines(bm, T).map((l) => Array.from(l));
    const flipPins = (l) => l.slice().reverse().map((b) => parseInt(b.toString(2).padStart(8, '0').split('').reverse().join(''), 2));
    const cases = [
        [{ reverseLines: true, reversePins: false }, base.slice().reverse()],
        [{ reverseLines: false, reversePins: true }, base.map(flipPins)],
        [{ reverseLines: true, reversePins: true }, base.map(flipPins).reverse()]
    ];
    for (const [orientation, expected] of cases) {
        assert.deepEqual(P.rasterLines(bm, orientation).map((l) => Array.from(l)), expected, JSON.stringify(orientation));
    }
});

test('[PRNT-02/encoding] the line count is a little-endian 32 bit number at offset 117', () => {
    for (const [width, le] of [[3, [3, 0, 0, 0]], [174, [174, 0, 0, 0]], [7058, [0x92, 0x1b, 0, 0]]]) {
        const job = P.buildJob(bitmap(width, []), { orientation: T });
        assert.deepEqual(Array.from(job.subarray(117, 121)), le, `width ${width}`);
        assert.equal(job.length, 139 + 19 * width);
    }
});

test('[PRNT-02/empty] a bitmap that is not 128 dots high throws before any byte is built', () => {
    const short = { width: 10, height: 100, stride: 2, bits: new Uint8Array(200) };
    assert.throws(() => P.buildJob(short), /label must be 128 dots high/);
    assert.throws(() => P.rasterLines(short), /label must be 128 dots high/);
});

test('[PRNT-02/empty] width + 2 x FEED_DOTS above 7086 throws, 7058 does not', () => {
    assert.throws(() => P.buildJob(bitmap(7059, [])), /Label is too long to print/);
    assert.doesNotThrow(() => P.buildJob(bitmap(7058, [])));
});

const fixture = () => bytes([0x80, 0x20, 0x42, 0x30, 0x76, 0x30, 0, 0, 0, 0, 0x18, 0x01], zeros(12), [0x01, 0x08], zeros(6));

test('parseStatus reads the 24 mm laminated idle fixture', () => {
    assert.equal(fixture().length, 32);
    const s = P.parseStatus(fixture());
    assert.equal(s.model, 0x76);
    assert.equal(s.widthMm, 24);
    assert.equal(s.mediaType, 1);
    assert.equal(s.statusType, 0);
    assert.deepEqual([s.err7, s.err8, s.err9], [0, 0, 0]);
    assert.deepEqual([s.tapeColour, s.textColour], [1, 8]);
    assert.deepEqual(Array.from(s.raw), Array.from(fixture()));
    assert.notEqual(s.raw, fixture());
});

test('[T-02-02] parseStatus rejects a short frame and a wrong header', () => {
    assert.throws(() => P.parseStatus(fixture().subarray(0, 31)), /not a status frame/);
    const bad = fixture();
    bad[0] = 0x81;
    assert.throws(() => P.parseStatus(bad), /not a status frame/);
    assert.throws(() => P.parseStatus(new Uint8Array(33)), /not a status frame/);
});

test('[PRNT-02/encoding] takeFrame resyncs on garbage, joins split frames and separates coalesced ones', () => {
    const f = fixture();
    const g = fixture();
    g[18] = 1;

    const prefixed = P.takeFrame(bytes([0x01, 0x80, 0x20, 0x00], Array.from(f)));
    assert.deepEqual(Array.from(prefixed.frame), Array.from(f), 'a lone 80 20 before the real header is not a header');
    const resynced = P.takeFrame(bytes([0x01, 0x02, 0x03], Array.from(f)));
    assert.deepEqual(Array.from(resynced.frame), Array.from(f));
    assert.equal(resynced.rest.length, 0);

    const first = P.takeFrame(f.subarray(0, 20));
    assert.equal(first.frame, null);
    assert.equal(first.rest.length, 20);
    const second = P.takeFrame(bytes(Array.from(first.rest), Array.from(f.subarray(20))));
    assert.deepEqual(Array.from(second.frame), Array.from(f));

    const two = P.takeFrame(bytes(Array.from(f), Array.from(g)));
    assert.deepEqual(Array.from(two.frame), Array.from(f));
    assert.equal(two.rest.length, 32);
    assert.deepEqual(Array.from(P.takeFrame(two.rest).frame), Array.from(g));

    const split = P.takeFrame(bytes([0xaa, 0xbb, 0x80, 0x20]));
    assert.equal(split.frame, null);
    assert.deepEqual(Array.from(split.rest), [0x80, 0x20], 'a header split across reads is kept');
    assert.equal(P.takeFrame(new Uint8Array(0)).frame, null);
});

test('formatRaw is lower-case hex separated by single spaces', () => {
    assert.equal(P.formatRaw(bytes([0x80, 0x0a, 0xff])), '80 0a ff');
    assert.equal(P.formatRaw(fixture()).split(' ').length, 32);
});

test('describeStatus: ok on the fixture, not ok with an error bit, type 2 or 4, or no tape', () => {
    assert.deepEqual(P.describeStatus(P.parseStatus(fixture())), { ok: true, code: 'ok', text: '' });
    const withErr = fixture();
    withErr[9] = 0x10;
    const d = P.describeStatus(P.parseStatus(withErr));
    assert.equal(d.ok, false);
    assert.equal(d.code, 'unknown');
    assert.equal(d.text, 'The printer reported an error.');
    for (const [index, value] of [[18, 2], [18, 4], [10, 0], [7, 1], [8, 1]]) {
        const f = fixture();
        f[index] = value;
        assert.equal(P.describeStatus(P.parseStatus(f)).ok, false, `byte ${index} = ${value}`);
    }
});

test('[D-08] tapeMismatchText names both widths', () => {
    assert.equal(P.tapeMismatchText({ widthMm: 12 }), 'The printer has 12 mm tape loaded, but this label is made for 24 mm tape.');
    assert.equal(P.tapeMismatchText({ widthMm: 24 }, 18), 'The printer has 24 mm tape loaded, but this label is made for 18 mm tape.');
});
