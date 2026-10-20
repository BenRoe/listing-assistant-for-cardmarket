// Pure helpers for the edition label page: 1-bit PNG encoder, glyph lookup, fragment parser, layout.
// No DOM access here, so Node tests can load it the same way as js/shared.js.
(function (root) {
    const TAPE_DOTS = 128;   // printable height on 24 mm tape
    const DPI = 180;
    const MIN_DOTS = 174;    // the printer feeds at least ~25.4 mm
    const PAD_X = 14;
    const PAD_Y = 8;
    const ICON_GAP = 16;
    const ICON_MAX_WIDTH = 150;
    const CODE_FONT = '700 44px Cinzel, serif';
    const MAX_SETS = 50;

    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes, crc = 0) {
        let c = ~crc >>> 0;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
        return ~c >>> 0;
    }

    function adler32(bytes) {
        let a = 1, b = 0;
        for (let i = 0; i < bytes.length; i++) {
            a = (a + bytes[i]) % 65521;
            b = (b + a) % 65521;
        }
        return ((b << 16) | a) >>> 0;
    }

    // rgba (canvas getImageData().data) -> packed 1-bit rows, MSB first, 1 = black ink. Alpha is composited on white.
    function toBitmap(rgba, width, height, threshold = 128) {
        const stride = (width + 7) >> 3;
        const bits = new Uint8Array(stride * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                const a = rgba[i + 3] / 255;
                const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a);
                if (lum < threshold) bits[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
            }
        }
        return { width, height, stride, bits };
    }

    const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

    function concat(parts) {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) {
            out.set(p, o);
            o += p.length;
        }
        return out;
    }

    function chunk(type, data) {
        const out = new Uint8Array(12 + data.length);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, data.length);
        for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        out.set(data, 8);
        dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));   // CRC covers type + data
        return out;
    }

    // RFC 1950 header 78 01, RFC 1951 stored blocks of <= 65535 bytes, Adler-32 trailer
    function zlibStored(raw) {
        const blocks = Math.max(1, Math.ceil(raw.length / 65535));
        const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
        out[0] = 0x78;
        out[1] = 0x01;
        let o = 2;
        for (let b = 0; b < blocks; b++) {
            const part = raw.subarray(b * 65535, (b + 1) * 65535);
            out[o++] = b === blocks - 1 ? 1 : 0;
            out[o++] = part.length & 255;
            out[o++] = part.length >> 8;
            out[o++] = ~part.length & 255;
            out[o++] = (~part.length >> 8) & 255;
            out.set(part, o);
            o += part.length;
        }
        out.set(be32(adler32(raw)), o);
        return out;
    }

    // PNG colour type 0, depth 1 (sample 0 = black, so ink bits are inverted here only).
    // pHYs is pixels per metre with unit 1 (metre): 180 dpi -> 7087.
    function encodePng1bit({ width, height, stride, bits }, dpi = DPI) {
        const raw = new Uint8Array(height * (stride + 1));   // filter byte 0 per row
        for (let y = 0; y < height; y++) {
            for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = ~bits[y * stride + i] & 255;
        }
        const ihdr = new Uint8Array([...be32(width), ...be32(height), 1, 0, 0, 0, 0]);
        const ppm = Math.round(dpi / 0.0254);
        const phys = new Uint8Array([...be32(ppm), ...be32(ppm), 1]);
        return concat([
            Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
            chunk('IHDR', ihdr), chunk('pHYs', phys), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))
        ]);
    }

    // Keyrune code point for a Scryfall set code; null when the font has no glyph (never the default glyph)
    function glyphFor(map, code) {
        if (typeof code !== 'string') return null;
        const key = code.trim().toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
        return typeof map[key] === 'number' ? map[key] : null;
    }

    // "#sets=ons,dom" -> ['ons', 'dom']; hostile or malformed segments are dropped
    function parseFragment(hash) {
        if (typeof hash !== 'string' || !hash) return [];
        const raw = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('sets');
        if (!raw) return [];
        const codes = [];
        for (const part of raw.split(',')) {
            const code = part.trim().toLowerCase();
            if (/^[a-z0-9]{2,6}$/.test(code) && !codes.includes(code)) codes.push(code);
            if (codes.length >= MAX_SETS) break;
        }
        return codes;
    }

    // measure(font, text) -> { width, ascent, descent, left, right } (canvas actualBoundingBox*, ink extents)
    // Returns { width, height, ops, empty, warnings }; the page draws ops verbatim.
    function layoutLabel(input, measure) {
        const ops = [];
        let contentRight = PAD_X;
        let textX = PAD_X;

        if (input.showIcon !== false && typeof input.glyph === 'number') {
            const m = measure('100px Keyrune', String.fromCodePoint(input.glyph));
            const inkH = m.ascent + m.descent;
            const inkW = m.left + m.right;
            if (inkH > 0 && inkW > 0) {
                const scale = Math.min((TAPE_DOTS - 2 * PAD_Y) / inkH, ICON_MAX_WIDTH / inkW);
                ops.push({
                    type: 'glyph',
                    font: `${100 * scale}px Keyrune`,
                    text: String.fromCodePoint(input.glyph),
                    x: PAD_X + m.left * scale,
                    y: TAPE_DOTS / 2 + (m.ascent - m.descent) * scale / 2
                });
                contentRight = PAD_X + inkW * scale;
                textX = contentRight + ICON_GAP;
            }
        }

        if (input.showCode !== false && typeof input.code === 'string' && input.code) {
            const text = input.code.toUpperCase();
            const cap = measure(CODE_FONT, 'H').ascent;
            const m = measure(CODE_FONT, text);
            ops.push({ type: 'text', font: CODE_FONT, text, x: textX, y: TAPE_DOTS / 2 + cap / 2 });
            contentRight = textX + m.right;
        }

        return {
            width: Math.max(MIN_DOTS, Math.ceil(contentRight + PAD_X)),
            height: TAPE_DOTS,
            ops,
            empty: ops.length === 0,
            warnings: []
        };
    }

    const api = {
        TAPE_DOTS, DPI, MIN_DOTS, PAD_X, PAD_Y, ICON_GAP,
        crc32, adler32, toBitmap, encodePng1bit, glyphFor, parseFragment, layoutLabel
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LabelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
