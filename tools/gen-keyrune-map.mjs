// Dev only (not shipped): node tools/gen-keyrune-map.mjs <keyrune.css> [out]
// Reads the Keyrune stylesheet and writes labels/keyrune-map.js (set code -> code point).
import { readFileSync, writeFileSync } from 'node:fs';

const [cssPath, out = new URL('../labels/keyrune-map.js', import.meta.url).pathname] = process.argv.slice(2);
if (!cssPath) {
    console.error('usage: node tools/gen-keyrune-map.mjs <keyrune.css> [out]');
    process.exit(2);
}

const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const map = {};
for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const content = /content:\s*"\\([0-9a-f]+)"/i.exec(body);
    if (!content) continue;
    const point = parseInt(content[1], 16);
    for (const selector of selectors.split(',').map((s) => s.trim())) {
        // Single colon only: skips the bare .ss rule and the duo ::before/::after layers.
        if (!/^\.ss-[a-z0-9_]+:before$/.test(selector)) continue;
        const code = selector.slice(4, -7);
        if (code in map && map[code] !== point) {
            console.error(`conflict: ${code} is assigned both ${map[code].toString(16)} and ${point.toString(16)}`);
            process.exit(1);
        }
        map[code] = point;
    }
}

writeFileSync(out,
    '// Generated from keyrune.css v3.19.0 by tools/gen-keyrune-map.mjs: set code -> code point in keyrune.woff2\n' +
    `(function (root) {\n    const map = ${JSON.stringify(map)};\n` +
    "    if (typeof module !== 'undefined' && module.exports) module.exports = map;\n" +
    '    else root.KEYRUNE = map;\n' +
    "})(typeof globalThis !== 'undefined' ? globalThis : this);\n");
console.log(`${Object.keys(map).length} entries -> ${out}`);
