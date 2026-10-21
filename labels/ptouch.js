// Brother PT-P710BT raster encoder and status parser. Pure functions, no device access, so Node tests load it directly.
// Byte sequences follow the Brother Raster Command Reference (PT-E550W/P750W/P710BT); other projects were only used as cross-checks.
(function (root) {
    const HEAD_BYTES = 16;                // 128 pins, 16 bytes per raster line
    const TAPE_DOTS = 128;                // print pins on 24 mm tape
    const TAPE_MM = 24;
    const FEED_DOTS = 14;                 // printer minimum margin before and after the artwork, 2 mm at 180 dpi (D-12)
    const MAX_LINES = 7086;               // printer maximum length, 1000 mm, margins included
    const INVALIDATE_LEN = 100;
    const STATUS_LEN = 32;
    const ADVANCED_MODE = 0x08;           // ESC i K bit 3: no chain printing, feed and cut after the label
    const ADVANCED_MODE_CUT_OFF = 0x08;   // the one value to change to 0x18 if hardware check HW-6 shows the printer still cuts
    // Convention T: line x is canvas column x, canvas row 0 is the MSB of byte 0. A wrong first print is fixed by flipping a flag here (HW-1).
    const ORIENTATION = { reverseLines: false, reversePins: false };

    const concat = (...parts) => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    };

    const invalidate = () => new Uint8Array(INVALIDATE_LEN);
    const init = () => Uint8Array.of(0x1b, 0x40);
    const statusRequest = () => Uint8Array.of(0x1b, 0x69, 0x53);

    function reverseByte(b) {
        let r = 0;
        for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
        return r;
    }

    // Reverses the order of all 128 pins of one line.
    function reversePins(line) {
        const out = new Uint8Array(HEAD_BYTES);
        for (let i = 0; i < HEAD_BYTES; i++) out[i] = reverseByte(line[HEAD_BYTES - 1 - i]);
        return out;
    }

    // One 16-byte line per dot column; bitmap is the Phase 1 contract { width, height, stride, bits } with 1 = ink.
    function rasterLines(bitmap, orientation = ORIENTATION) {
        if (bitmap.height !== TAPE_DOTS) throw new Error('label must be 128 dots high');
        const { width, stride, bits } = bitmap;
        const lines = [];
        for (let x = 0; x < width; x++) {
            const line = new Uint8Array(HEAD_BYTES);
            const mask = 0x80 >> (x & 7);
            for (let y = 0; y < TAPE_DOTS; y++) {
                if (bits[y * stride + (x >> 3)] & mask) line[y >> 3] |= 0x80 >> (y & 7);
            }
            lines.push(orientation.reversePins ? reversePins(line) : line);
        }
        return orientation.reverseLines ? lines.reverse() : lines;
    }

    // One complete single-label job. Never ESC i A (unsupported on this model) and never Z (raw lines only).
    function buildJob(bitmap, { cut = true, feedDots = FEED_DOTS, orientation = ORIENTATION } = {}) {
        if (bitmap.height !== TAPE_DOTS) throw new Error('label must be 128 dots high');
        if (bitmap.width + 2 * feedDots > MAX_LINES) throw new Error('Label is too long to print');
        const lines = rasterLines(bitmap, orientation);
        const n = lines.length;
        const header = Uint8Array.of(
            0x1b, 0x40,                                                   // initialize
            0x1b, 0x69, 0x61, 0x01,                                       // raster mode
            0x1b, 0x69, 0x21, 0x00,                                       // status notification on
            0x1b, 0x69, 0x7a, 0x84, 0x00, TAPE_MM, 0x00,                  // print info: recover and width valid, 24 mm, length 0
            n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff, 0x00, 0x00,   // raster line count, first page, fixed 0
            0x1b, 0x69, 0x4d, cut ? 0x40 : 0x00,                          // auto cut
            0x1b, 0x69, 0x4b, cut ? ADVANCED_MODE : ADVANCED_MODE_CUT_OFF,   // advanced mode
            0x1b, 0x69, 0x64, feedDots & 0xff, (feedDots >> 8) & 0xff,    // margin
            0x4d, 0x00                                                    // no compression
        );
        const out = new Uint8Array(INVALIDATE_LEN + header.length + n * (3 + HEAD_BYTES) + 1);
        out.set(header, INVALIDATE_LEN);
        let o = INVALIDATE_LEN + header.length;
        for (const line of lines) {
            out.set([0x47, 0x10, 0x00], o);
            out.set(line, o + 3);
            o += 3 + HEAD_BYTES;
        }
        out[o] = 0x1a;   // print with feeding
        return out;
    }

    // Splits the first complete 32-byte status frame off a receive buffer; resyncs on the header 80 20 42.
    function takeFrame(bytes) {
        let at = -1;
        for (let i = 0; i + 2 < bytes.length; i++) {
            if (bytes[i] === 0x80 && bytes[i + 1] === 0x20 && bytes[i + 2] === 0x42) { at = i; break; }
        }
        if (at < 0) return { frame: null, rest: bytes.slice(Math.max(0, bytes.length - 2)) };   // a header may be split across reads
        if (bytes.length - at < STATUS_LEN) return { frame: null, rest: bytes.slice(at) };
        return { frame: bytes.slice(at, at + STATUS_LEN), rest: bytes.slice(at + STATUS_LEN) };
    }

    function parseStatus(frame) {
        if (frame.length !== STATUS_LEN || frame[0] !== 0x80 || frame[1] !== 0x20 || frame[2] !== 0x42) throw new Error('not a status frame');
        return {
            model: frame[4], err7: frame[7], err8: frame[8], err9: frame[9], widthMm: frame[10], mediaType: frame[11],
            mode: frame[15], statusType: frame[18], phaseType: frame[19], phaseNumber: (frame[20] << 8) | frame[21],
            notification: frame[22], tapeColour: frame[24], textColour: frame[25], raw: Uint8Array.from(frame)
        };
    }

    const formatRaw = (frame) => Array.from(frame, (b) => b.toString(16).padStart(2, '0')).join(' ');

    // The sentence table lands in plan 02-04; the shape { ok, code, text } is final.
    function describeStatus(status) {
        const ok = !status.err7 && !status.err8 && !status.err9 && status.statusType !== 2 && status.statusType !== 4 && status.widthMm !== 0;
        return ok ? { ok: true, code: 'ok', text: '' } : { ok: false, code: 'unknown', text: 'The printer reported an error.' };
    }

    const tapeMismatchText = (status, wantMm = TAPE_MM) =>
        `The printer has ${status.widthMm} mm tape loaded, but this label is made for ${wantMm} mm tape.`;

    const api = {
        HEAD_BYTES, TAPE_DOTS, TAPE_MM, FEED_DOTS, MAX_LINES, INVALIDATE_LEN, STATUS_LEN, ADVANCED_MODE, ADVANCED_MODE_CUT_OFF, ORIENTATION,
        invalidate, init, statusRequest, rasterLines, buildJob, takeFrame, parseStatus, formatRaw, describeStatus, tapeMismatchText, concat
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PTouch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
