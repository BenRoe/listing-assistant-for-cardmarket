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

    const CONDITIONS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
    const MAX_DOTS = 7086;           // 1000 mm, the printer maximum
    const DEFAULT_MAX_MM = 100;
    const SMALL_SIZE = 22;
    const BIG_SIZE = 44;
    const WRAP_SIZES = [34, 30, 26];
    const LINE_GAP = 12;
    const BADGE_GAP = 10;
    const BADGE_PAD_X = 7;
    const BADGE_PAD_Y = 6;
    const ONE_LINE_MAX = 520;
    const NAME_FONT = (size) => `700 ${size}px Cinzel, serif`;
    const WARNING_ORDER = ['no-glyph', 'empty', 'over-max', 'overflow-fixed'];

    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
    const mmToDots = (mm) => Math.round(mm / 25.4 * DPI);

    function normalizeCondition(value) {
        if (typeof value !== 'string') return 'none';
        const code = value.trim().toUpperCase();
        return CONDITIONS.includes(code) ? code : 'none';
    }

    // case, diacritics and ligatures removed, for search and file names
    function fold(text) {
        return String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
            .replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss');
    }

    // Text that fits in avail: one 44 px line, else the best two-line split at 34, 30 or 26 px.
    function fitBig(text, avail, measure) {
        const one = measure(NAME_FONT(BIG_SIZE), text).right;
        if (one <= Math.min(avail, ONE_LINE_MAX)) return { size: BIG_SIZE, lines: [text], widest: one };
        const words = text.split(' ');
        let best = null;
        for (const size of WRAP_SIZES) {
            const font = NAME_FONT(size);
            best = { size, lines: [text], widest: measure(font, text).right };
            for (let i = 1; i < words.length; i++) {
                const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
                const widest = Math.max(...lines.map((l) => measure(font, l).right));
                if (widest < best.widest) best = { size, lines, widest };
            }
            if (best.widest <= avail) break;
        }
        return best;
    }

    // measure(font, text) -> { width, ascent, descent, left, right } (canvas actualBoundingBox*, ink extents)
    // Returns { width, height, ops, empty, warnings }; the page draws ops verbatim.
    function layoutLabel(input, measure) {
        const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        const cond = normalizeCondition(input.cond);
        const foil = input.foil === true;
        const warn = new Set();
        const showIcon = input.showIcon !== false;
        const hasGlyph = typeof input.glyph === 'number';
        if (showIcon && !hasGlyph) warn.add('no-glyph');

        // the code is promoted to the big line when the name is off or empty (D-04) and is then not repeated
        const showName = input.showName !== false;
        const showCode = input.showCode !== false;
        const promoted = !(showName && name) && (showName || showCode) && code !== '';
        const bigText = showName && name ? name : promoted ? code : '';
        const smallCode = showCode && !promoted ? code : '';

        const ops = [];
        let contentRight = PAD_X;
        let textX = PAD_X;
        let hasIcon = false;
        if (showIcon && hasGlyph) {
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
                hasIcon = true;
                contentRight = PAD_X + inkW * scale;
                textX = contentRight + ICON_GAP;
            }
        }

        const hasSmall = Boolean(smallCode) || foil || cond !== 'none';
        if (!hasIcon && !bigText && !hasSmall) {
            warn.add('empty');
            return { width: MIN_DOTS, height: TAPE_DOTS, ops: [], empty: true, warnings: WARNING_ORDER.filter((w) => warn.has(w)) };
        }

        const fixedMm = input.fixedMm;
        const fixedDots = typeof fixedMm === 'number' && Number.isFinite(fixedMm) && fixedMm > 0
            ? clamp(mmToDots(fixedMm), MIN_DOTS, MAX_DOTS) : null;
        const maxMm = typeof input.maxMm === 'number' && Number.isFinite(input.maxMm) && input.maxMm > 0 ? input.maxMm : DEFAULT_MAX_MM;
        const limitDots = fixedDots ?? clamp(mmToDots(maxMm), MIN_DOTS, MAX_DOTS);
        const avail = Math.max(limitDots - PAD_X - textX, 40);

        // line boxes top to bottom: { height, draw(top) }
        const lines = [];
        if (bigText) {
            const fit = fitBig(bigText, avail, measure);
            const font = NAME_FONT(fit.size);
            const cap = Math.round(measure(font, 'H').ascent);
            for (const text of fit.lines) {
                lines.push({
                    height: cap,
                    draw: (top) => {
                        ops.push({ type: 'text', font, text, x: textX, y: top + cap });
                        contentRight = Math.max(contentRight, textX + measure(font, text).right);
                    }
                });
            }
        }
        if (hasSmall) {
            const font = NAME_FONT(SMALL_SIZE);
            const cap = Math.round(measure(font, 'H').ascent);
            const hasBadge = foil || cond !== 'none';
            lines.push({
                height: hasBadge ? cap + 2 * BADGE_PAD_Y : cap,
                draw: (top) => {
                    const baseline = top + (hasBadge ? BADGE_PAD_Y : 0) + cap;
                    let x = textX;
                    const place = (text, radius) => {
                        const w = Math.ceil(measure(font, text).width) + 2 * BADGE_PAD_X;
                        ops.push({ type: 'box', x, y: top, w, h: cap + 2 * BADGE_PAD_Y, radius, lineWidth: 2 });
                        ops.push({ type: 'text', font, text, x: x + BADGE_PAD_X, y: baseline });
                        x += w + BADGE_GAP;
                    };
                    if (smallCode) {
                        ops.push({ type: 'text', font, text: smallCode, x, y: baseline });
                        x += measure(font, smallCode).right + BADGE_GAP;
                    }
                    if (foil) place('FOIL', 6);
                    if (cond !== 'none') place(cond, 0);
                    contentRight = Math.max(contentRight, x - BADGE_GAP);
                }
            });
        }

        const total = lines.reduce((n, l) => n + l.height, 0) + LINE_GAP * Math.max(0, lines.length - 1);
        let top = Math.round((TAPE_DOTS - total) / 2);
        for (const line of lines) {
            line.draw(top);
            top += line.height + LINE_GAP;
        }

        const contentWidth = Math.ceil(contentRight + PAD_X);
        let width;
        if (fixedDots !== null) {
            width = fixedDots;
            if (contentWidth > width) warn.add('overflow-fixed');
        } else {
            width = clamp(contentWidth, MIN_DOTS, MAX_DOTS);
            if (contentWidth > limitDots) warn.add('over-max');
        }
        return { width, height: TAPE_DOTS, ops, empty: false, warnings: WARNING_ORDER.filter((w) => warn.has(w)) };
    }

    const slug = (text) => fold(typeof text === 'string' ? text : '')
        .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    // code-name-foil-condition.png: only [a-z0-9-] survives, so no path separators or dot-dot reach a ZIP entry
    function fileName({ code, name, foil, cond } = {}) {
        const condition = normalizeCondition(cond);
        const parts = [slug(code), slug(name), foil === true ? 'foil' : '', condition === 'none' ? '' : condition.toLowerCase()];
        const base = parts.filter(Boolean).join('-').slice(0, 100).replace(/-+$/, '');
        return `${base || 'label'}.png`;
    }

    // Keeps order; a duplicate gets -2, -3 ... before the extension, skipping every name used or still to come.
    function uniqueNames(names) {
        const reserved = new Set(names.map((n) => n.toLowerCase()));
        const used = new Set();
        return names.map((name) => {
            let out = name;
            if (used.has(out.toLowerCase())) {
                const dot = name.lastIndexOf('.');
                const stem = dot > 0 ? name.slice(0, dot) : name;
                const ext = dot > 0 ? name.slice(dot) : '';
                for (let n = 2; ; n++) {
                    out = `${stem}-${n}${ext}`;
                    if (!used.has(out.toLowerCase()) && !reserved.has(out.toLowerCase())) break;
                }
            }
            used.add(out.toLowerCase());
            return out;
        });
    }

    const captionFor = (widthDots) => `${Math.round(widthDots / DPI * 25.4)} x 18 mm printable (24 mm tape)`;

    // packed 1-bit bitmap -> RGBA, ink black and paper white, both opaque (inverse of toBitmap)
    function bitmapToRgba({ width, height, stride, bits }) {
        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const v = bits[y * stride + (x >> 3)] & (0x80 >> (x & 7)) ? 0 : 255;
                rgba.fill(v, (y * width + x) * 4, (y * width + x) * 4 + 3);
                rgba[(y * width + x) * 4 + 3] = 255;
            }
        }
        return rgba;
    }

    const api = {
        TAPE_DOTS, DPI, MIN_DOTS, PAD_X, PAD_Y, ICON_GAP, CONDITIONS, MAX_DOTS, DEFAULT_MAX_MM,
        crc32, adler32, toBitmap, encodePng1bit, glyphFor, parseFragment, layoutLabel,
        mmToDots, normalizeCondition, fold, fileName, uniqueNames, captionFor, bitmapToRgba
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LabelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
