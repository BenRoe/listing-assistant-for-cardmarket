import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../labels/ptouch.js');
const { createSession, PrinterError, NO_ANSWER_TEXT, SILENCE_BASE_MS, SILENCE_PER_LINE_MS } = require('../labels/printer.js');

const coded = (code, message) => Object.assign(new Error(message), { code });

// Transport contract: chunkSize, write, read(timeoutMs), drain, close. Received bytes are queued as segments; an empty queue times out at once.
class FakeTransport {
    constructor({ chunkSize = 1024, onWrite = null } = {}) {
        this.chunkSize = chunkSize;
        this.onWrite = onWrite;
        this.written = [];
        this.readCalls = [];
        this.segments = [];
        this.failWriteAt = null;     // 1-based index of the write that rejects with lost
        this.failReadWhenEmpty = null;
    }

    push(...chunks) { for (const c of chunks) this.segments.push(Uint8Array.from(c)); }

    async write(bytes) {
        if (this.failWriteAt === this.written.length + 1) throw coded('lost', 'The printer was unplugged or switched off.');
        this.written.push(bytes.slice());
        if (this.onWrite) this.onWrite(bytes, (...chunks) => this.push(...chunks), this);
    }

    async read(timeoutMs) {
        this.readCalls.push(timeoutMs);
        if (this.segments.length) return this.segments.shift();
        if (this.failReadWhenEmpty) throw this.failReadWhenEmpty;
        throw coded('timeout', 'No data received');
    }

    drain() { this.segments = []; }
    async close() {}
}

const frame = ({ width = 24, media = 1, err7 = 0, err8 = 0, err9 = 0, type = 0, phase = 0, phaseNo = 0, notif = 0 } = {}) => {
    const f = new Uint8Array(32);
    f.set([0x80, 0x20, 0x42, 0x30, 0x76, 0x30]);
    f[7] = err7; f[8] = err8; f[9] = err9; f[10] = width; f[11] = media;
    f[18] = type; f[19] = phase; f[20] = phaseNo >> 8; f[21] = phaseNo & 0xff; f[22] = notif;
    return f;
};
const hex = (f) => P.formatRaw(f);

const isStatusRequest = (b) => b.length === 105 && b[102] === 0x1b && b[103] === 0x69 && b[104] === 0x53;
const statusRequests = (t) => t.written.filter(isStatusRequest);
const jobBytes = (t) => t.written.filter((b) => !isStatusRequest(b));
const joined = (chunks) => Uint8Array.from(chunks.flatMap((c) => Array.from(c)));
// A raster line header 47 10 00 or the raster mode command 1B 69 61 01 anywhere in what was written
const hasJobByte = (t) => {
    const all = Array.from(joined(t.written));
    return all.some((b, i) => (b === 0x47 && all[i + 1] === 0x10 && all[i + 2] === 0x00) || (b === 0x1b && all[i + 1] === 0x69 && all[i + 2] === 0x61 && all[i + 3] === 0x01));
};

function bitmap(width = 100) {
    const stride = (width + 7) >> 3;
    const bits = new Uint8Array(stride * 128);
    for (let x = 0; x < width; x += 3) bits[(x % 128) * stride + (x >> 3)] |= 0x80 >> (x & 7);
    return { width, height: 128, stride, bits };
}

const COMPLETION = () => [frame({ type: 6, phase: 1 }), frame({ type: 1 }), frame({ type: 6 })];

// statuses: one entry per status request (null = silence); afterSlice: { n: frameBytes } pushed after the n-th job slice; completion: frames pushed after the last byte
function rig({ statuses = [frame()], afterSlice = {}, completion = COMPLETION(), chunkSize = 64, width = 100, coalesce = false } = {}) {
    const queue = [...statuses];
    const total = P.buildJob(bitmap(width), { cut: true }).length;
    let sent = 0, slices = 0;
    const t = new FakeTransport({
        chunkSize,
        onWrite: (bytes, push) => {
            if (isStatusRequest(bytes)) {
                const next = queue.shift();
                if (next) push(next);
                return;
            }
            sent += bytes.length;
            slices += 1;
            if (afterSlice[slices]) push(afterSlice[slices]);
            if (sent >= total) {
                if (coalesce) push(joined(completion));
                else push(...completion);
            }
        }
    });
    t.totalSlices = Math.ceil(total / chunkSize);
    return t;
}

const reject = async (promise, code) => {
    try {
        await promise;
    } catch (e) {
        assert.ok(e instanceof PrinterError, `PrinterError expected, got ${e && e.stack}`);
        assert.equal(e.code, code, e.message);
        return e;
    }
    assert.fail(`expected a PrinterError with code ${code}`);
};

test('[PRNT-02] an ok job writes one status request and the whole job in slices; its phase frames do not abort it', async () => {
    const t = rig();
    await createSession(t).print(bitmap(100), { cut: true });
    assert.equal(statusRequests(t).length, 1);
    assert.deepEqual(Array.from(joined(jobBytes(t))), Array.from(P.buildJob(bitmap(100), { cut: true })));
    assert.ok(jobBytes(t).every((b) => b.length <= 64));
    assert.deepEqual(Array.from(t.written[0].subarray(100)), [0x1b, 0x40, 0x1b, 0x69, 0x53]);
});

test('[PRNT-02] cut off reaches the job bytes', async () => {
    const t = rig();
    await createSession(t).print(bitmap(100), { cut: false });
    assert.deepEqual(Array.from(joined(jobBytes(t))), Array.from(P.buildJob(bitmap(100), { cut: false })));
});

test('[PRNT-03] a 12 mm tape is refused before any job byte, naming both widths and carrying the raw bytes', async () => {
    const reply = frame({ width: 12 });
    const t = rig({ statuses: [reply] });
    const e = await reject(createSession(t).print(bitmap()), 'tape-mismatch');
    assert.equal(e.message, 'The printer has 12 mm tape loaded, but this label is made for 24 mm tape.');
    assert.equal(e.raw, hex(reply));
    assert.equal(e.status.widthMm, 12);
    assert.equal(jobBytes(t).length, 0);
    assert.equal(hasJobByte(t), false);
});

test('[PRNT-03/empty] no tape (width 0, media type 00 or error bit 01) is refused before any job byte', async () => {
    for (const reply of [frame({ width: 0, media: 0 }), frame({ width: 24, media: 0 }), frame({ err8: 0x01 })]) {
        const t = rig({ statuses: [reply] });
        const e = await reject(createSession(t).print(bitmap()), 'no-tape');
        assert.equal(e.message, 'No tape is loaded. Insert a 24 mm TZe cassette and press Print again.');
        assert.equal(e.raw, hex(reply));
        assert.equal(hasJobByte(t), false);
    }
});

test('[PRNT-03/encoding] media type FF is refused, types 14 and 15 are accepted, other widths are refused by millimetres', async () => {
    const e = await reject(createSession(rig({ statuses: [frame({ media: 0xff })] })).print(bitmap()), 'incompatible-tape');
    assert.equal(e.message, 'The loaded tape is not compatible with this printer.');
    for (const media of [0x14, 0x15]) await createSession(rig({ statuses: [frame({ media })] })).print(bitmap());
    for (const width of [4, 6, 9, 12, 18, 36]) {
        const t = rig({ statuses: [frame({ width })] });
        await reject(createSession(t).print(bitmap()), 'tape-mismatch');
        assert.equal(hasJobByte(t), false);
    }
});

test('[PRNT-04] cover open before the job, low battery, overheating, bad adapter and cutter jam refuse without a job byte', async () => {
    const cases = [
        [{ err9: 0x10 }, 'cover-open', 'Cover is open. Close it and press Print again.'],
        [{ phaseNo: 0x14 }, 'cover-open', 'Cover is open. Close it and press Print again.'],
        [{ err8: 0x08 }, 'low-battery', 'The battery is low. Connect the USB cable or charge the printer, then print again.'],
        [{ err9: 0x20 }, 'overheated', 'The print head is too hot. Wait a few minutes and press Print again.'],
        [{ err8: 0x40 }, 'bad-adapter', 'The power adapter does not suit this printer. Use the adapter that came with it.'],
        [{ err8: 0x04 }, 'cutter-jam', 'The cutter is jammed. Switch the printer off, clear the jam and try again.'],
        [{ type: 4 }, 'powered-off', 'The printer switched itself off. Switch it on and connect again.']
    ];
    for (const [patch, code, text] of cases) {
        const reply = frame(patch);
        const t = rig({ statuses: [reply] });
        const e = await reject(createSession(t).print(bitmap()), code);
        assert.equal(e.message, text);
        assert.equal(e.raw, hex(reply));
        assert.equal(hasJobByte(t), false, code);
    }
});

test('[PRNT-04/concurrency] a cover-open error frame between write slices stops the write: nothing is written afterwards, nothing is resent', async () => {
    const t = rig({ afterSlice: { 2: frame({ err9: 0x10, type: 2 }) } });
    const e = await reject(createSession(t).print(bitmap()), 'cover-open');
    assert.equal(e.message, 'Cover is open. Close it and press Print again.');
    assert.equal(e.raw, hex(frame({ err9: 0x10, type: 2 })));
    assert.equal(jobBytes(t).length, 2, 'the two slices before the error frame');
    assert.ok(jobBytes(t).length < t.totalSlices);
    assert.equal(statusRequests(t).length, 1, 'no status request during the job and no retry');
    const job = P.buildJob(bitmap(), { cut: true });
    assert.deepEqual(Array.from(joined(jobBytes(t))), Array.from(job.subarray(0, 128)), 'only the first two slices of the job were written');
});

test('[PRNT-04/concurrency] an error frame behind a normal phase frame between slices is still found', async () => {
    const t = rig({ afterSlice: { 1: joined([frame({ type: 6, phase: 1 }), frame({ err8: 0x04, type: 2 })]) } });
    await reject(createSession(t).print(bitmap()), 'cutter-jam');
    assert.equal(jobBytes(t).length, 1);
});

test('[PRNT-04] the normal phase frames between slices (even with width 0) do not abort the job', async () => {
    const t = rig({ afterSlice: { 1: frame({ type: 6, phase: 1, width: 0, media: 0 }) } });
    await createSession(t).print(bitmap());
    assert.equal(joined(jobBytes(t)).length, P.buildJob(bitmap(), { cut: true }).length);
});

test('[PRNT-04] wrong media or a cutter jam reported while waiting for completion fail the label', async () => {
    const wrong = await reject(createSession(rig({ completion: [frame({ type: 6, phase: 1 }), frame({ type: 2, err9: 0x01 })] })).print(bitmap()), 'wrong-media');
    assert.equal(wrong.message, 'The loaded tape does not match this job. Check the cassette and press Print again.');
    const jam = await reject(createSession(rig({ completion: [frame({ type: 2, err8: 0x04 })] })).print(bitmap()), 'cutter-jam');
    assert.equal(jam.message, 'The cutter is jammed. Switch the printer off, clear the jam and try again.');
});

test('[PRNT-04] silence after the last byte times out with the no-answer sentence after 30000 + 15 x width ms, without a resend', async () => {
    const t = rig({ completion: [], width: 100 });
    const e = await reject(createSession(t).print(bitmap(100)), 'timeout');
    assert.equal(e.message, NO_ANSWER_TEXT);
    assert.ok(t.readCalls.includes(SILENCE_BASE_MS + SILENCE_PER_LINE_MS * 100));
    assert.ok(t.readCalls.includes(30000 + 15 * 100));
    assert.equal(jobBytes(t).length, t.totalSlices, 'the job was written once');
});

test('[PRNT-04/empty] unknown bits give the unknown sentence with the code and the raw bytes', async () => {
    const reply = frame({ err8: 0x80 });
    const e = await reject(createSession(rig({ statuses: [reply] })).print(bitmap()), 'unknown');
    assert.equal(e.message, 'The printer reported an unknown error (code 0x80).');
    assert.equal(e.raw, hex(reply));
});

test('[PRNT-04] connection lost on a write and on a status read ends with the lost sentence', async () => {
    const onWrite = rig({ afterSlice: {} });
    onWrite.failWriteAt = 3;   // status request, slice 1, slice 2 fails
    const e = await reject(createSession(onWrite).print(bitmap()), 'lost');
    assert.equal(e.message, 'Connection lost: The printer was unplugged or switched off. The printer may have switched itself off.');
    assert.match(e.message, /^Connection lost:/);
    assert.equal(statusRequests(onWrite).length, 1);

    const onRead = rig({ statuses: [null] });
    onRead.failReadWhenEmpty = coded('lost', 'The printer was unplugged or switched off.');
    const read = await reject(createSession(onRead).readStatus(), 'lost');
    assert.match(read.message, /^Connection lost: The printer was unplugged or switched off\. The printer may have switched itself off\.$/);

    const first = rig();
    first.failWriteAt = 1;
    await reject(createSession(first).readStatus(), 'lost');
});

test('[PRNT-04] a lost connection between write slices (found by the poll) ends the job and is not retried', async () => {
    const t = rig();
    const original = t.read.bind(t);
    let polls = 0;
    t.read = async (ms) => {
        if (ms === 0 && ++polls === 2) throw coded('lost', 'The printer was switched off or went out of range.');
        return original(ms);
    };
    const e = await reject(createSession(t).print(bitmap()), 'lost');
    assert.match(e.message, /^Connection lost: The printer was switched off or went out of range\./);
    assert.equal(statusRequests(t).length, 1);
});

test('[PRNT-04] a status request that times out is repeated, three timeouts give the no-answer sentence', async () => {
    const t = rig({ statuses: [null, frame()] });
    await createSession(t).print(bitmap());
    assert.equal(statusRequests(t).length, 2);

    const silent = rig({ statuses: [null, null, null, frame()] });
    const e = await reject(createSession(silent).print(bitmap()), 'timeout');
    assert.equal(e.message, NO_ANSWER_TEXT);
    assert.equal(statusRequests(silent).length, 3);
    assert.equal(hasJobByte(silent), false);
});

test('[PRNT-04] a printer that only reports a printing phase gives the busy sentence after the last attempt', async () => {
    const busy = frame({ type: 6, phase: 1 });
    const t = rig({ statuses: [busy, busy, busy] });
    const e = await reject(createSession(t).print(bitmap()), 'busy');
    assert.equal(e.message, 'The printer is busy printing. Wait for it to finish, then press Refresh.');
    assert.equal(e.raw, hex(busy));
    assert.equal(statusRequests(t).length, 3);
    assert.equal(hasJobByte(t), false);
});

test('[PRNT-04] frames of type 0, 2 and 4 are replies; a notification before the reply is skipped', async () => {
    const t = rig({ statuses: [null] });
    t.onWrite = (bytes, push) => { if (isStatusRequest(bytes)) push(frame({ type: 5, notif: 2 }), frame()); };
    const status = await createSession(t).readStatus();
    assert.equal(status.statusType, 0);
    const off = rig();
    off.onWrite = (bytes, push) => { if (isStatusRequest(bytes)) push(frame({ type: 4 })); };
    assert.equal((await createSession(off).readStatus()).statusType, 4);
});

test('[PRNT-04] frames in the queue before the request are ignored', async () => {
    const t = rig();
    t.push(frame({ err9: 0x10 }), frame({ err8: 0x04, type: 2 }));
    await createSession(t).print(bitmap());
    assert.equal(statusRequests(t).length, 1);
});

test('[PRNT-04/encoding] a garbage prefix and split or coalesced frames around the reply and the completion are handled', async () => {
    const reply = frame();
    const split = rig();
    split.onWrite = (bytes, push) => {
        if (isStatusRequest(bytes)) push([0x00, 0x7f, 0x80, 0x20], [...reply.subarray(0, 10)].slice(2), [...reply.subarray(10, 31)], [...reply.subarray(31)]);
    };
    const status = await createSession(split).readStatus();
    assert.equal(status.widthMm, 24);
    assert.equal(P.formatRaw(status.raw), P.formatRaw(reply));

    const coalesced = rig({ coalesce: true });
    await createSession(coalesced).print(bitmap());
    assert.equal(jobBytes(coalesced).length, coalesced.totalSlices);

    const garbage = rig({ statuses: [Uint8Array.from([1, 2, 3, ...frame()])] });
    await createSession(garbage).print(bitmap());
});

test('[PRNT-04] the same session recovers: after a failure the next print starts with a fresh status request and a stale error frame does not poison it', async () => {
    const script = [{ 2: frame({ err9: 0x10, type: 2 }) }, {}];
    const statuses = [frame(), frame()];
    const total = P.buildJob(bitmap(), { cut: true }).length;
    let run = 0, sent = 0, slices = 0;
    const t = new FakeTransport({
        chunkSize: 64,
        onWrite: (bytes, push) => {
            if (isStatusRequest(bytes)) { run += 1; sent = 0; slices = 0; push(statuses.shift()); return; }
            sent += bytes.length;
            slices += 1;
            if (script[run - 1][slices]) push(script[run - 1][slices]);
            if (sent >= total) push(...COMPLETION());
        }
    });
    const session = createSession(t);
    await reject(session.print(bitmap()), 'cover-open');
    t.push(frame({ err8: 0x04, type: 2 }));   // late stale frame from the failed job
    await session.print(bitmap());
    assert.equal(statusRequests(t).length, 2);
});

test('exports', () => {
    assert.equal(typeof NO_ANSWER_TEXT, 'string');
    assert.equal(new PrinterError('x', 'm').status, null);
    assert.equal(new PrinterError('x', 'm').raw, '');
});
