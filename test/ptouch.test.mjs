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
const head = (cutByte, modeByte = 0x08) => [
    zeros(100), [0x1b, 0x40], [0x1b, 0x69, 0x61, 0x01], [0x1b, 0x69, 0x21, 0x00],
    [0x1b, 0x69, 0x7a, 0x84, 0x00, 0x18, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00],   // 3 artwork lines + 14 trailing blank lines = 17
    [0x1b, 0x69, 0x4d, cutByte], [0x1b, 0x69, 0x4b, modeByte], [0x1b, 0x69, 0x64, 0x0e, 0x00], [0x4d, 0x00]
];
const goldenJob = (cutByte, modeByte) => bytes(
    head(cutByte, modeByte),
    [0x47, 0x10, 0x00, 0x80, ...zeros(15)],
    [0x47, 0x10, 0x00, ...zeros(15), 0x01],
    [0x47, 0x10, 0x00, 0x00, 0x80, ...zeros(14)],
    Array.from({ length: 14 }, () => [0x47, 0x10, 0x00, ...zeros(16)]),   // trailing 2 mm, blank lines after the artwork only
    [0x1a]
);

test('[D-02/D-04] buildJob of the 3 column golden bitmap is the 462 reference bytes (artwork plus 14 trailing blank lines), cut on', () => {
    const job = P.buildJob(golden, { cut: true, orientation: T, leadDots: 0, leadDots: 0 });
    assert.equal(job.length, 462);
    assert.deepEqual(Array.from(job), Array.from(goldenJob(0x40)));
});

test('[D-02/D-04] cut off differs only in the ESC i M and ESC i K values', () => {
    const on = P.buildJob(golden, { cut: true, orientation: T, leadDots: 0, leadDots: 0 });
    const off = P.buildJob(golden, { cut: false, orientation: T, leadDots: 0, leadDots: 0 });
    assert.deepEqual(Array.from(off), Array.from(goldenJob(0x00, 0x18)));
    const diff = Array.from(on).flatMap((b, i) => (b === off[i] ? [] : [i]));
    assert.deepEqual(diff, [126, 130]);
});

test('[D-12] the default margin is 14 dots (2 mm) and the printed length is lines plus 2 x FEED_DOTS (plus the trailing lines)', () => {
    assert.equal(P.FEED_DOTS, 14);
    const job = P.buildJob(golden, { orientation: T, leadDots: 0, leadDots: 0 });
    assert.deepEqual(Array.from(job.subarray(131, 136)), [0x1b, 0x69, 0x64, 14, 0]);
    const wide = Array.from(P.buildJob(golden, { orientation: T, leadDots: 0, feedDots: 300 }).subarray(131, 136));
    assert.deepEqual(wide, [0x1b, 0x69, 0x64, 0x2c, 0x01]);
});

test('[owner wish after HW-1] 14 blank lines follow the artwork and no line precedes it; the margin stays symmetric', () => {
    assert.equal(P.TRAIL_DOTS, 14);
    const lines = P.rasterLines(golden, T);
    const job = P.buildJob(golden, { orientation: T, leadDots: 0, leadDots: 0 });
    assert.equal(job.length, 139 + 19 * (lines.length + 14));
    assert.deepEqual(Array.from(job.subarray(138, 138 + 3 + 16)), [0x47, 0x10, 0x00, 0x80, ...zeros(15)], 'the first line sent is still artwork column 0');
    const tail = job.subarray(138 + 3 * 19, job.length - 1);
    assert.equal(tail.length, 14 * 19);
    for (let i = 0; i < 14; i++) assert.deepEqual(Array.from(tail.subarray(i * 19, i * 19 + 19)), [0x47, 0x10, 0x00, ...zeros(16)], `trailing line ${i}`);
    assert.equal(job[job.length - 1], 0x1a);
    assert.deepEqual(Array.from(job.subarray(131, 136)), [0x1b, 0x69, 0x64, 14, 0], 'ESC i d is unchanged');
    const none = P.buildJob(golden, { orientation: T, leadDots: 0, trailDots: 0 });
    assert.equal(none.length, 196);
    assert.deepEqual(Array.from(none.subarray(117, 121)), [3, 0, 0, 0]);
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

test('[PRNT-02/encoding] the line count (artwork plus 14 trailing lines) is a little-endian 32 bit number at offset 117', () => {
    for (const [width, le] of [[3, [17, 0, 0, 0]], [174, [188, 0, 0, 0]], [7044, [0x92, 0x1b, 0, 0]]]) {
        const job = P.buildJob(bitmap(width, []), { orientation: T, leadDots: 0, leadDots: 0 });
        assert.deepEqual(Array.from(job.subarray(117, 121)), le, `width ${width}`);
        assert.equal(job.length, 139 + 19 * (width + 14));
    }
});

test('[PRNT-02/empty] a bitmap that is not 128 dots high throws before any byte is built', () => {
    const short = { width: 10, height: 100, stride: 2, bits: new Uint8Array(200) };
    assert.throws(() => P.buildJob(short), /label must be 128 dots high/);
    assert.throws(() => P.rasterLines(short), /label must be 128 dots high/);
});

test('[PRNT-02/empty] width + 10 lead + 14 trailing + 2 x FEED_DOTS above 7086 throws, 7034 does not', () => {
    assert.throws(() => P.buildJob(bitmap(7035, [])), /Label is too long to print/);
    assert.doesNotThrow(() => P.buildJob(bitmap(7034, [])));
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

const status = (patch = {}) => {
    const f = fixture();
    for (const [index, value] of Object.entries(patch)) f[Number(index)] = value;
    return P.parseStatus(f);
};

test('describeStatus: ok on the fixture and with media types 03, 14 and 15', () => {
    assert.deepEqual(P.describeStatus(status()), { ok: true, code: 'ok', text: '' });
    for (const media of [0x03, 0x14, 0x15]) assert.equal(P.describeStatus(status({ 11: media })).ok, true, `media ${media}`);
});

// [patch, code, sentence]
const mapped = [
    [{ 8: 0x01 }, 'no-tape', 'No tape is loaded. Insert a 24 mm TZe cassette and press Print again.'],
    [{ 8: 0x04 }, 'cutter-jam', 'The cutter is jammed. Switch the printer off, clear the jam and try again.'],
    [{ 8: 0x08 }, 'low-battery', 'The battery is low. Connect the USB cable or charge the printer, then print again.'],
    [{ 8: 0x40 }, 'bad-adapter', 'The power adapter does not suit this printer. Use the adapter that came with it.'],
    [{ 9: 0x01 }, 'wrong-media', 'The loaded tape does not match this job. Check the cassette and press Print again.'],
    [{ 9: 0x10 }, 'cover-open', 'Cover is open. Close it and press Print again.'],
    [{ 9: 0x20 }, 'overheated', 'The print head is too hot. Wait a few minutes and press Print again.'],
    [{ 21: 0x14 }, 'cover-open', 'Cover is open. Close it and press Print again.'],
    [{ 22: 0x01 }, 'cover-open', 'Cover is open. Close it and press Print again.'],
    [{ 18: 4 }, 'powered-off', 'The printer switched itself off. Switch it on and connect again.'],
    [{ 18: 6, 19: 1 }, 'busy', 'The printer is busy printing. Wait for it to finish, then press Refresh.'],
    [{ 18: 5, 19: 1 }, 'busy', 'The printer is busy printing. Wait for it to finish, then press Refresh.'],
    [{ 10: 0 }, 'no-tape', 'No tape is loaded. Insert a 24 mm TZe cassette and press Print again.'],
    [{ 11: 0 }, 'no-tape', 'No tape is loaded. Insert a 24 mm TZe cassette and press Print again.'],
    [{ 11: 0xff }, 'incompatible-tape', 'The loaded tape is not compatible with this printer.'],
    [{ 18: 2 }, 'unknown', 'The printer reported an unknown error.']
];

test('[PRNT-04] describeStatus returns the exact sentence for every mapped condition', () => {
    for (const [patch, code, text] of mapped) assert.deepEqual(P.describeStatus(status(patch)), { ok: false, code, text }, JSON.stringify(patch));
});

test('[PRNT-04] describeStatus: unmapped non-zero bits give unknown with the first non-zero byte as hex', () => {
    const unknown = (code) => ({ ok: false, code: 'unknown', text: `The printer reported an unknown error (code 0x${code}).` });
    assert.deepEqual(P.describeStatus(status({ 7: 0x02 })), unknown('02'));
    assert.deepEqual(P.describeStatus(status({ 8: 0x80 })), unknown('80'));
    assert.deepEqual(P.describeStatus(status({ 8: 0x02 })), unknown('02'));
    assert.deepEqual(P.describeStatus(status({ 9: 0x04 })), unknown('04'));
    assert.deepEqual(P.describeStatus(status({ 7: 0x10, 8: 0x80, 9: 0x04 })), unknown('10'), 'byte 7 comes first');
    assert.deepEqual(P.describeStatus(status({ 8: 0x80, 9: 0x04 })), unknown('80'), 'then byte 8');
});

test('[PRNT-04] describeStatus precedence: byte 8, byte 9, byte 7, then phase and type, then tape', () => {
    assert.equal(P.describeStatus(status({ 8: 0x01, 9: 0x10 })).code, 'no-tape');
    assert.equal(P.describeStatus(status({ 8: 0x05, 9: 0x10 })).code, 'no-tape', 'lowest bit of byte 8 first');
    assert.equal(P.describeStatus(status({ 8: 0x08, 9: 0x10 })).code, 'low-battery');
    assert.equal(P.describeStatus(status({ 8: 0x40, 9: 0x01 })).code, 'bad-adapter');
    assert.equal(P.describeStatus(status({ 9: 0x01 | 0x10 })).code, 'wrong-media');
    assert.equal(P.describeStatus(status({ 9: 0x10 | 0x20 })).code, 'cover-open');
    assert.equal(P.describeStatus(status({ 7: 1, 9: 0x20 })).code, 'overheated', 'mapped bits beat byte 7');
    assert.equal(P.describeStatus(status({ 7: 1, 21: 0x14 })).code, 'unknown', 'byte 7 beats the phase number');
    assert.equal(P.describeStatus(status({ 21: 0x14, 18: 4 })).code, 'cover-open', 'phase number beats status type');
    assert.equal(P.describeStatus(status({ 18: 4, 10: 0 })).code, 'powered-off', 'status type beats the tape rules');
    assert.equal(P.describeStatus(status({ 18: 6, 19: 1, 10: 0 })).code, 'busy', 'busy beats the tape rules');
    assert.equal(P.describeStatus(status({ 11: 0xff, 10: 0 })).code, 'incompatible-tape', 'incompatible beats no tape');
});

test('[PRNT-04] describeStatus duringJob: the frames of a normal job pass, with width 24 and with width 0, errors still fail', () => {
    for (const width of [24, 0]) {
        for (const patch of [{ 18: 6, 19: 1 }, { 18: 1 }, { 18: 6, 19: 0 }, { 18: 5, 19: 1 }, {}]) {
            assert.equal(P.describeStatus(status({ 10: width, ...patch }), { duringJob: true }).ok, true, `width ${width} ${JSON.stringify(patch)}`);
        }
    }
    assert.equal(P.describeStatus(status({ 11: 0 }), { duringJob: true }).ok, true);
    // error bits, cover and power conditions still fail during a job; only the busy and tape-width/type rules are skipped
    const skippedInJob = (patch) => ['busy', 'incompatible-tape'].includes(P.describeStatus(status(patch)).code) || (!(8 in patch) && P.describeStatus(status(patch)).code === 'no-tape');
    for (const [patch, code] of mapped) {
        assert.equal(P.describeStatus(status(patch), { duringJob: true }).ok, skippedInJob(patch), `${code} ${JSON.stringify(patch)} during a job`);
    }
    assert.equal(P.describeStatus(status({ 18: 2 }), { duringJob: true }).ok, false);
    assert.equal(P.describeStatus(status({ 18: 4 }), { duringJob: true }).ok, false);
});

test('[T-02-13] describeStatus never throws and always returns a sentence for 1000 random 32-byte frames', () => {
    let seed = 0x2545f491;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
    for (let n = 0; n < 1000; n++) {
        const f = Uint8Array.from({ length: 32 }, next);
        f.set([0x80, 0x20, 0x42]);
        for (const opts of [undefined, { duringJob: true }]) {
            const d = P.describeStatus(P.parseStatus(f), opts);
            assert.equal(typeof d.ok, 'boolean');
            assert.equal(typeof d.code, 'string');
            assert.equal(typeof d.text, 'string');
            assert.equal(d.ok, d.text === '');
        }
    }
    const zero = bytes([0x80, 0x20, 0x42], zeros(29));
    assert.equal(P.describeStatus(P.parseStatus(zero)).code, 'no-tape', 'an all-zero reply is an empty bay');
});

test('[D-08] tapeMismatchText names both widths', () => {
    assert.equal(P.tapeMismatchText({ widthMm: 12 }), 'The printer has 12 mm tape loaded, but this label is made for 24 mm tape.');
    assert.equal(P.tapeMismatchText({ widthMm: 24 }, 18), 'The printer has 24 mm tape loaded, but this label is made for 18 mm tape.');
});

test('[HW-6 chain] cut off and chain: ESC i K 0x10 and the job ends with 0x0c; the last label of a run ends with 0x1a', () => {
    const chained = P.buildJob(golden, { cut: false, chain: true, orientation: T, leadDots: 0 });
    const last = P.buildJob(golden, { cut: false, orientation: T, leadDots: 0 });
    assert.equal(chained[130], 0x10);
    assert.equal(chained[chained.length - 1], 0x0c);
    assert.equal(last[last.length - 1], 0x1a);
    assert.equal(P.buildJob(golden, { cut: true, chain: true, orientation: T, leadDots: 0 })[chained.length - 1], 0x1a, 'cut on never chains');
});

test('[HW-6 chain] a next page is only print info, raster and terminator: no reset, no invalidate', () => {
    const job = P.buildJob(golden, { cut: false, chain: true, next: true, orientation: T, leadDots: 0 });
    assert.deepEqual(Array.from(job.subarray(0, 13)), [0x1b, 0x69, 0x7a, 0x84, 0x00, 0x18, 0x00, 0x11, 0, 0, 0, 0x01, 0x00]);
    assert.equal(job.length, 13 + 17 * 19 + 1);
    assert.equal(job[job.length - 1], 0x0c);
    const final = P.buildJob(golden, { cut: false, next: true, orientation: T, leadDots: 0 });
    assert.deepEqual(Array.from(final.subarray(0, 4)), [0x1b, 0x69, 0x4b, 0x18], 'the last page returns to no chain');
    assert.equal(final[final.length - 1], 0x1a);
});
