// Brother PT-P710BT raster encoder and status parser. Pure functions, no device access, so Node tests load it directly.
// Byte sequences follow the Brother Raster Command Reference (PT-E550W/P750W/P710BT); other projects were only used as cross-checks.
(function (root) {
    const HEAD_BYTES = 16;                // 128 pins, 16 bytes per raster line
    const TAPE_DOTS = 128;                // print pins on 24 mm tape
    const TAPE_MM = 24;
    const FEED_DOTS = 14;                 // printer minimum margin before and after the artwork, 2 mm at 180 dpi (D-12)
    const TRAIL_DOTS = 14;                // extra blank lines after the artwork only, 2 mm at 180 dpi (owner wish after HW-1; ESC i d feeds both ends)
    const LEAD_DOTS = 10;                 // extra blank lines before the artwork only, about 1.4 mm; brings the measured start margin from 4-5 mm to 6 mm (HW-9)
    const MAX_LINES = 7086;               // printer maximum length, 1000 mm, margins and trailing lines included
    const INVALIDATE_LEN = 100;
    const STATUS_LEN = 32;
    const ADVANCED_MODE = 0x08;           // ESC i K bit 3: no chain printing, feed and cut after the label
    const ADVANCED_MODE_CHAIN = 0x10;     // cut off and chain printing: no feed to the cutter after the label, the next job continues the strip
    const ADVANCED_MODE_CUT_OFF = 0x18;   // bit 4 no cut; 0x08 alone still cut at the end of each label (HW-6)
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

    // One complete single-label job. next: a further page of a chain already held in the printer; it sends only the print info and the raster, no reset (a reset or status request drops the held page, HW-6). Never ESC i A (unsupported on this model) and never Z (raw lines only).
    function buildJob(bitmap, { cut = true, feedDots = FEED_DOTS, leadDots = LEAD_DOTS, trailDots = TRAIL_DOTS, chain = false, next = false, orientation = ORIENTATION } = {}) {
        if (bitmap.height !== TAPE_DOTS) throw new Error('label must be 128 dots high');
        if (bitmap.width + leadDots + trailDots + 2 * feedDots > MAX_LINES) throw new Error('Label is too long to print');
        const lines = rasterLines(bitmap, orientation);
        for (let i = 0; i < leadDots; i++) lines.unshift(new Uint8Array(HEAD_BYTES));   // first lines sent are the leading end of the tape
        for (let i = 0; i < trailDots; i++) lines.push(new Uint8Array(HEAD_BYTES));   // last lines sent are the trailing end of the tape
        const n = lines.length;
        const header = next ? Uint8Array.of(
            ...(chain ? [] : [0x1b, 0x69, 0x4b, ADVANCED_MODE_CUT_OFF]),   // last page: back to no chain
            0x1b, 0x69, 0x7a, 0x84, 0x00, TAPE_MM, 0x00,
            n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff, 0x01, 0x00   // not the first page
        ) : Uint8Array.of(
            0x1b, 0x40,                                                   // initialize
            0x1b, 0x69, 0x61, 0x01,                                       // raster mode
            0x1b, 0x69, 0x21, 0x00,                                       // status notification on
            0x1b, 0x69, 0x7a, 0x84, 0x00, TAPE_MM, 0x00,                  // print info: recover and width valid, 24 mm, length 0
            n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff, 0x00, 0x00,   // raster line count, first page, fixed 0
            0x1b, 0x69, 0x4d, cut ? 0x40 : 0x00,                          // auto cut
            0x1b, 0x69, 0x4b, cut ? ADVANCED_MODE : (chain ? ADVANCED_MODE_CHAIN : ADVANCED_MODE_CUT_OFF),   // advanced mode
            0x1b, 0x69, 0x64, feedDots & 0xff, (feedDots >> 8) & 0xff,    // margin
            0x4d, 0x00                                                    // no compression
        );
        const lead = next ? 0 : INVALIDATE_LEN;
        const out = new Uint8Array(lead + header.length + n * (3 + HEAD_BYTES) + 1);
        out.set(header, lead);
        let o = lead + header.length;
        for (const line of lines) {
            out.set([0x47, 0x10, 0x00], o);
            out.set(line, o + 3);
            o += 3 + HEAD_BYTES;
        }
        out[o] = !cut && chain ? 0x0c : 0x1a;   // 0x0c prints and keeps the label in the head, 0x1a feeds it out
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

    const SENTENCES = {
        'no-tape': 'No tape is loaded. Insert a 24 mm TZe cassette and press Print again.',
        'incompatible-tape': 'The loaded tape is not compatible with this printer.',
        'wrong-media': 'The loaded tape does not match this job. Check the cassette and press Print again.',
        'cover-open': 'Cover is open. Close it and press Print again.',
        'overheated': 'The print head is too hot. Wait a few minutes and press Print again.',
        'cutter-jam': 'The cutter is jammed. Switch the printer off, clear the jam and try again.',
        'low-battery': 'The battery is low. Connect the USB cable or charge the printer, then print again.',
        'bad-adapter': 'The power adapter does not suit this printer. Use the adapter that came with it.',
        'powered-off': 'The printer switched itself off. Switch it on and connect again.',
        'busy': 'The printer is busy printing. Wait for it to finish, then press Refresh.',
        'unknown': 'The printer reported an unknown error.'
    };
    // [byte, bit, code] in order of precedence: error info 1, then error info 2
    const ERROR_BITS = [['err8', 0x01, 'no-tape'], ['err8', 0x04, 'cutter-jam'], ['err8', 0x08, 'low-battery'], ['err8', 0x40, 'bad-adapter'],
        ['err9', 0x01, 'wrong-media'], ['err9', 0x10, 'cover-open'], ['err9', 0x20, 'overheated']];
    const KNOWN_BITS = { err8: 0x4d, err9: 0x31 };

    // Total over any parsed status. duringJob skips the busy and tape rules: the phase change and completion frames of a normal job are not errors.
    function describeStatus(status, { duringJob = false } = {}) {
        const verdict = (code, text = SENTENCES[code]) => ({ ok: false, code, text });
        for (const [byte, bit, code] of ERROR_BITS) if (status[byte] & bit) return verdict(code);
        if ((status.err8 & ~KNOWN_BITS.err8) || (status.err9 & ~KNOWN_BITS.err9) || status.err7) {
            const first = status.err7 || status.err8 || status.err9;   // mapped bits returned above, so a non-zero err8 or err9 is unmapped here
            return verdict('unknown', `The printer reported an unknown error (code 0x${first.toString(16).padStart(2, '0')}).`);
        }
        if (status.phaseNumber === 0x0014 || status.notification === 1) return verdict('cover-open');
        if (status.statusType === 4) return verdict('powered-off');
        if (status.statusType === 2) return verdict('unknown');
        if (duringJob) return { ok: true, code: 'ok', text: '' };
        if ((status.statusType === 5 || status.statusType === 6) && status.phaseType === 1) return verdict('busy');
        if (status.mediaType === 0xff) return verdict('incompatible-tape');
        if (status.widthMm === 0 || status.mediaType === 0) return verdict('no-tape');
        return { ok: true, code: 'ok', text: '' };
    }

    const tapeMismatchText = (status, wantMm = TAPE_MM) =>
        `The printer has ${status.widthMm} mm tape loaded, but this label is made for ${wantMm} mm tape.`;

    const api = {
        HEAD_BYTES, TAPE_DOTS, TAPE_MM, FEED_DOTS, TRAIL_DOTS, LEAD_DOTS, MAX_LINES, INVALIDATE_LEN, STATUS_LEN, ADVANCED_MODE, ADVANCED_MODE_CHAIN, ADVANCED_MODE_CUT_OFF, ORIENTATION,
        invalidate, init, statusRequest, rasterLines, buildJob, takeFrame, parseStatus, formatRaw, describeStatus, tapeMismatchText, concat, SENTENCES
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PTouch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
