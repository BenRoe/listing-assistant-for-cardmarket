// Dev only (not shipped): headless Chromium smoke test of labels/ served over plain HTTP.
// PLAYWRIGHT_CORE=/path/to/playwright-core node tools/smoke-labels.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'));
} catch {
    console.error('SMOKE FAIL: playwright-core not found, set PLAYWRIGHT_CORE');
    process.exit(2);
}
const { crc32 } = require('../labels/core.js');

const ROOT = fileURLToPath(new URL('../labels/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.md': 'text/markdown', '.txt': 'text/plain' };

function serve() {
    const server = createServer(async (req, res) => {
        const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (path === '/favicon.ico') return res.writeHead(204).end();
        const file = normalize(join(ROOT, path));
        if (file !== ROOT.slice(0, -1) && !file.startsWith(ROOT)) return res.writeHead(403).end();
        try {
            res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
        } catch {
            res.writeHead(404).end();
        }
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Walks the chunks (CRC checked) and returns what the scenarios assert on; ink = 1.
function readPng(bytes) {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!sig.every((b, i) => bytes[i] === b)) throw new Error('not a PNG');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const order = [];
    let ihdr, phys, idat = [];
    for (let o = 8; o < bytes.length;) {
        const len = dv.getUint32(o), type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
        const data = bytes.subarray(o + 8, o + 8 + len);
        if (crc32(bytes.subarray(o + 4, o + 8 + len)) !== dv.getUint32(o + 8 + len)) throw new Error(`bad CRC in ${type}`);
        order.push(type);
        if (type === 'IHDR') ihdr = { width: dv.getUint32(o + 8), height: dv.getUint32(o + 12), depth: data[8], colour: data[9], interlace: data[12] };
        if (type === 'pHYs') phys = { x: dv.getUint32(o + 8), y: dv.getUint32(o + 12), unit: data[8] };
        if (type === 'IDAT') idat.push(data);
        o += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = (ihdr.width + 7) >> 3;
    const ink = (x, y) => (~raw[y * (stride + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
    return { ...ihdr, phys, order, ink };
}

const scenarios = [
    ['tracer', async (page, base, expect) => {
        await page.goto(`${base}/labels.html#sets=ons`);
        await page.waitForSelector('#cards .card[data-ready="1"]');
        expect(await page.evaluate(() => document.fonts.check('100px Keyrune', String.fromCodePoint(0xe62e))), 'Keyrune font loaded');
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('button[data-action="download"]')]);
        const chunks = [];
        for await (const c of await download.createReadStream()) chunks.push(c);
        const png = readPng(new Uint8Array(Buffer.concat(chunks)));
        expect(png.width >= 174 && png.height === 128, `size ${png.width}x${png.height}`);
        expect(png.depth === 1 && png.colour === 0 && png.interlace === 0, 'IHDR 1-bit grey, not interlaced');
        expect(png.phys.x === 7087 && png.phys.y === 7087 && png.phys.unit === 1, 'pHYs 7087 px/m');
        expect(png.order.join() === 'IHDR,pHYs,IDAT,IEND', `chunk order ${png.order}`);
        let total = 0, left = 0;
        for (let y = 0; y < png.height; y++) {
            for (let x = 0; x < png.width; x++) {
                if (!png.ink(x, y)) continue;
                total++;
                if (x < 128) left++;
            }
        }
        expect(total > 0 && left > 0, `ink total ${total}, left ${left}`);
    }],
    ['empty', async (page, base, expect) => {
        await page.goto(`${base}/labels.html`);
        await page.waitForSelector('#empty:not([hidden])');
        expect(await page.locator('#cards .card').count() === 0, 'no cards');
    }]
];

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
let browser, code = 0;
try {
    browser = await chromium.launch();
    for (const [name, run] of scenarios) {
        const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
        const problems = [], hosts = new Set();
        page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
        page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
        page.on('request', (r) => hosts.add(new URL(r.url()).host));
        const expect = (ok, what) => { if (!ok) throw new Error(`${name}: ${what}`); };
        await run(page, base, expect);
        expect(problems.length === 0, problems.join('; '));
        expect([...hosts].every((h) => h === base.slice(7)), `external requests: ${[...hosts]}`);
    }
    console.log('SMOKE OK');
} catch (e) {
    console.error(`SMOKE FAIL: ${e.message}`);
    code = 1;
} finally {
    await browser?.close();
    server.close();
}
process.exit(code);
