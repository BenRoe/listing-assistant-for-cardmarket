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
    const SMALL_SIZE = 30;
    const SMALL_WRAPPED_SIZE = 22;   // a two-line name leaves little height
    const BIG_SIZES = [60, 52, 44];
    // a big line with no small line below it has the most height; a promoted code is short, so it can be larger still with one
    const ALONE_SIZES = [104, 92, 80, 68, 60, 52, 44];
    const CODE_BADGE_SIZES = [76, 68, 60, 52, 44];
    const WRAP_SIZES = [34, 30, 26];
    const NAME_MIN = 16;
    const SHRINK_SIZES = Array.from({ length: 25 - NAME_MIN + 1 }, (_, i) => 25 - i);
    const LINE_GAP = 12;
    const BADGE_GAP = 10;
    const BADGE_PAD_X = 7;
    const BADGE_PAD_Y = 6;
    const NAME_FONT = (size) => `700 ${size}px Cinzel, serif`;
    const WARNING_ORDER = ['no-glyph', 'empty', 'over-max'];

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

    // Text that fits in avail: one line at the largest of the given sizes, else the best two-line split at
    // 34, 30 or 26 px. With shrink (a max length is set) the two-line size keeps falling down to NAME_MIN.
    function fitBig(text, avail, measure, sizes = BIG_SIZES, shrink = false) {
        let one = 0;
        for (const size of sizes) {
            one = measure(NAME_FONT(size), text).right;
            if (one <= avail) return { size, lines: [text], widest: one };
        }
        const words = text.split(' ');
        let best = null;
        for (const size of shrink ? [...WRAP_SIZES, ...SHRINK_SIZES] : WRAP_SIZES) {
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

        const maxSet = typeof input.maxMm === 'number' && Number.isFinite(input.maxMm) && input.maxMm > 0;
        const maxMm = maxSet ? input.maxMm : DEFAULT_MAX_MM;
        const limitDots = clamp(mmToDots(maxMm), MIN_DOTS, MAX_DOTS);
        const avail = Math.max(limitDots - PAD_X - textX, 40);

        // line boxes top to bottom: { height, draw(top) }
        const lines = [];
        let smallSize = SMALL_SIZE;
        if (bigText) {
            const fit = fitBig(bigText, avail, measure, !hasSmall ? ALONE_SIZES : promoted ? CODE_BADGE_SIZES : BIG_SIZES, maxSet);
            if (fit.lines.length > 1) smallSize = SMALL_WRAPPED_SIZE;
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
            const font = NAME_FONT(smallSize);
            const cap = Math.round(measure(font, 'H').ascent);
            // the line always reserves the badge padding, so the name and code do not move when FOIL or a condition is toggled
            lines.push({
                height: cap + 2 * BADGE_PAD_Y,
                draw: (top) => {
                    const baseline = top + BADGE_PAD_Y + cap;
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
        const width = clamp(contentWidth, MIN_DOTS, MAX_DOTS);
        if (contentWidth > limitDots) warn.add('over-max');
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

    // Store-only ZIP (method 0, UTF-8 names flagged with bit 11, no ZIP64): files = [{ name, data: Uint8Array }]
    function zipStore(files, date = new Date()) {
        const enc = new TextEncoder();
        const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
        const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
        const local = [];
        const central = [];
        let offset = 0;
        for (const f of files) {
            const name = enc.encode(f.name);
            const crc = crc32(f.data);
            const h = new DataView(new ArrayBuffer(30));   // local file header
            h.setUint32(0, 0x04034b50, true);
            h.setUint16(4, 20, true);
            h.setUint16(6, 0x0800, true);
            h.setUint16(10, dosTime, true);
            h.setUint16(12, dosDate, true);
            h.setUint32(14, crc, true);
            h.setUint32(18, f.data.length, true);
            h.setUint32(22, f.data.length, true);
            h.setUint16(26, name.length, true);
            local.push(new Uint8Array(h.buffer), name, f.data);
            const c = new DataView(new ArrayBuffer(46));   // central directory header
            c.setUint32(0, 0x02014b50, true);
            c.setUint16(4, 20, true);
            c.setUint16(6, 20, true);
            c.setUint16(8, 0x0800, true);
            c.setUint16(12, dosTime, true);
            c.setUint16(14, dosDate, true);
            c.setUint32(16, crc, true);
            c.setUint32(20, f.data.length, true);
            c.setUint32(24, f.data.length, true);
            c.setUint16(28, name.length, true);
            c.setUint32(42, offset, true);
            central.push(new Uint8Array(c.buffer), name);
            offset += 30 + name.length + f.data.length;
        }
        const cd = concat(central);
        const e = new DataView(new ArrayBuffer(22));   // end of central directory
        e.setUint32(0, 0x06054b50, true);
        e.setUint16(8, files.length, true);
        e.setUint16(10, files.length, true);
        e.setUint32(12, cd.length, true);
        e.setUint32(16, offset, true);
        return concat([...local, cd, new Uint8Array(e.buffer)]);
    }

    // Set records: { code, name, released_at, set_type, digital }
    const HIDDEN_SET_TYPES = ['token', 'promo', 'memorabilia', 'minigame'];
    const SET_CODE = /^[a-z0-9]{2,6}$/;
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

    function filterSets(sets, showAll) {
        return sets.filter((s) => s.digital !== true && (showAll === true || !HIDDEN_SET_TYPES.includes(s.set_type)));
    }

    // oldest first; undated sets last; ties by name then code
    function sortSets(sets) {
        const dated = (s) => typeof s.released_at === 'string' && ISO_DATE.test(s.released_at);
        const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'en') || String(a.code ?? '').localeCompare(String(b.code ?? ''));
        return [...sets].sort((a, b) => {
            if (dated(a) !== dated(b)) return dated(a) ? -1 : 1;
            if (dated(a) && a.released_at !== b.released_at) return a.released_at < b.released_at ? -1 : 1;
            return byName(a, b);
        });
    }

    // rank 0 code equals the query, 1 code starts with it, 2 folded name contains it; stable inside a rank
    function searchSets(sets, query) {
        const q = fold(typeof query === 'string' ? query : '').trim();
        if (!q) return [...sets];
        const rank = (s) => {
            const code = fold(s.code);
            if (code === q) return 0;
            if (code.startsWith(q)) return 1;
            return fold(s.name).includes(q) ? 2 : -1;
        };
        return sets.map((s) => ({ s, r: rank(s) })).filter((x) => x.r >= 0)
            .sort((a, b) => a.r - b.r)   // Array.prototype.sort is stable
            .map((x) => x.s);
    }

    // file = { rows, binder } from storage.local csvs; only setCode and setName are read, never quantities
    function groupCsvSets(file) {
        const rows = file && Array.isArray(file.rows) ? file.rows : [];
        const binder = file && typeof file.binder === 'string' ? file.binder : '';
        const sets = new Map();
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            if (binder && binder !== '*' && row.binder !== binder) continue;
            const code = typeof row.setCode === 'string' ? row.setCode.trim().toLowerCase() : '';
            if (!SET_CODE.test(code) || sets.has(code)) continue;
            sets.set(code, typeof row.setName === 'string' ? row.setName : '');
        }
        return [...sets].map(([code, name]) => ({ code, name }));
    }

    function resolveSet(list, code, fallbackName) {
        const key = typeof code === 'string' ? code.trim().toLowerCase() : '';
        return list.find((s) => s.code === key)
            ?? { code: key, name: fallbackName || key.toUpperCase(), released_at: null, set_type: '', digital: false };
    }

    // Scryfall /sets JSON (or an array) -> validated records; throws so the page can fall back to its cache
    function trimSets(json) {
        const list = Array.isArray(json) ? json : json && Array.isArray(json.data) ? json.data : null;
        if (!list) throw new Error('Scryfall set list is not a list');
        const out = [];
        for (const s of list) {
            if (!s || typeof s !== 'object') continue;
            const code = typeof s.code === 'string' ? s.code.trim().toLowerCase() : '';
            const name = typeof s.name === 'string' ? s.name.trim() : '';
            if (!SET_CODE.test(code) || !name || name.length > 200) continue;
            out.push({
                code,
                name,
                released_at: typeof s.released_at === 'string' && ISO_DATE.test(s.released_at) ? s.released_at : null,
                set_type: typeof s.set_type === 'string' && s.set_type.length <= 40 ? s.set_type : '',
                digital: s.digital === true
            });
        }
        if (!out.length) throw new Error('Scryfall set list had no valid sets');
        return out;
    }

    // stored page settings: anything unexpected falls back to the default
    function normalizeSettings(raw) {
        const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const bool = (v, d) => (typeof v === 'boolean' ? v : d);
        const length = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? clamp(v, 24.5, 1000) : null);
        return {
            icon: bool(o.icon, true),
            name: bool(o.name, true),
            code: bool(o.code, true),
            maxMm: length(o.maxMm),
            foil: bool(o.foil, false),
            cond: normalizeCondition(o.cond)
        };
    }


    const api = {
        TAPE_DOTS, DPI, MIN_DOTS, PAD_X, PAD_Y, ICON_GAP, CONDITIONS, MAX_DOTS, DEFAULT_MAX_MM,
        crc32, adler32, toBitmap, encodePng1bit, glyphFor, parseFragment, layoutLabel,
        mmToDots, normalizeCondition, fold, fileName, uniqueNames, captionFor, bitmapToRgba,
        HIDDEN_SET_TYPES, zipStore, filterSets, sortSets, searchSets, groupCsvSets, resolveSet, trimSets, normalizeSettings
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LabelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
