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

// Fixture for GET https://api.scryfall.com/sets (the only external request the page may make)
const SET_FIXTURE = { object: 'list', has_more: false, data: [
    { code: 'ons', name: 'Onslaught', set_type: 'expansion', released_at: '2002-10-07', digital: false },
    { code: 'aer', name: '\u00C6ther Revolt', set_type: 'expansion', released_at: '2017-01-20', digital: false },
    { code: 'dom', name: 'Dominaria', set_type: 'expansion', released_at: '2018-04-27', digital: false },
    { code: 'clb', name: 'Commander Legends: Battle for Baldur\u2019s Gate', set_type: 'draft_innovation', released_at: '2022-06-10', digital: false },
    { code: 'tmt', name: 'Teenage Mutant Ninja Turtles Source Material', set_type: 'expansion', released_at: '2025-11-07', digital: false },
    { code: 'trk', name: 'Test Realm Kingdom', set_type: 'expansion', released_at: '2030-01-01', digital: false },
    { code: 'nul', name: 'Undated Set', set_type: 'expansion', released_at: null, digital: false },
    { code: 'tdom', name: 'Dominaria Tokens', set_type: 'token', released_at: '2018-04-27', digital: false },
    { code: 'pmg', name: 'Magazine Inserts', set_type: 'promo', released_at: '2018-01-01', digital: false },
    { code: 'mgm', name: 'Mini Game Set', set_type: 'minigame', released_at: '2005-01-01', digital: false },
    { code: 'dig', name: 'Digital Only', set_type: 'expansion', released_at: '2019-01-01', digital: true }
] };

const rowCodes = (page, list) => page.evaluate((id) => [...document.querySelectorAll(`#${id} .set-row`)].map((r) => r.dataset.code), list);

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
    ['fonts', async (page, base, expect) => {
        const missing = [];
        page.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
        await page.goto(`${base}/labels.html#sets=ons`);
        await page.waitForSelector('#cards .card[data-ready="1"]');
        const fonts = await page.evaluate(() => ({
            check: document.fonts.check('700 44px Cinzel', 'Aa'),
            loaded: [...document.fonts].some((f) => f.family.includes('Cinzel') && f.status === 'loaded')
        }));
        expect(fonts.check, 'Cinzel check');
        expect(fonts.loaded, 'Cinzel face status loaded');
        expect(missing.length === 0, `404: ${missing}`);
    }],
    ['empty', async (page, base, expect) => {
        await page.goto(`${base}/labels.html`);
        await page.waitForSelector('#empty:not([hidden])');
        expect(await page.locator('#cards .card').count() === 0, 'no cards');
    }],
    ['picker', async (page, base, expect, env) => {
        await page.goto(`${base}/labels.html`);
        await page.waitForSelector('#allSets .set-row');
        expect(await page.locator('.card').count() === 0, 'no card on open');
        expect(await page.locator('#empty').isVisible(), 'empty text visible');
        expect((await rowCodes(page, 'allSets')).join() === 'ons,aer,dom,clb,tmt,trk,nul', `default rows ${await rowCodes(page, 'allSets')}`);
        expect(env.sets.requests === 1, `one sets request, got ${env.sets.requests}`);

        await page.check('#showAll');
        const all = await rowCodes(page, 'allSets');
        expect(['tdom', 'pmg', 'mgm'].every((c) => all.includes(c)) && !all.includes('dig'), `show all rows ${all}`);
        expect(all.indexOf('ons') < all.indexOf('mgm') && all.indexOf('mgm') < all.indexOf('pmg') && all.indexOf('pmg') < all.indexOf('dom'), `oldest first ${all}`);
        await page.uncheck('#showAll');

        await page.fill('#search', 'aether');
        expect((await rowCodes(page, 'allSets')).join() === 'aer', 'search aether');
        await page.fill('#search', 'ons');
        expect((await rowCodes(page, 'allSets'))[0] === 'ons', 'search ons first');
        await page.fill('#search', 'zzzzzz');
        expect((await page.textContent('#allSets')).includes('No sets match'), 'no match text');

        const second = await env.context.newPage();
        await second.goto(`${base}/labels.html#sets=ons,dom`);
        await second.waitForSelector('#cards .card[data-ready="1"]');
        await second.waitForFunction(() => document.querySelectorAll('#cards .card[data-ready="1"]').length === 2);
        expect(env.sets.requests === 1, `second visit made a sets request (${env.sets.requests})`);
        expect((await second.$$eval('#cards .card', (c) => c.map((x) => x.dataset.code))).join() === 'ons,dom', 'cards in date order');
        const ticked = await second.$$eval('#allSets input:checked', (b) => b.map((x) => x.dataset.code));
        expect(ticked.join() === 'ons,dom', `ticked ${ticked}`);
        await second.click('#allSets input[data-code="dom"]');
        expect(await second.locator('#cards .card').count() === 1, 'untick removes the card');
    }],
    ['offline', async (page, base, expect, env) => {
        env.sets.mode = 'abort';
        await page.goto(`${base}/labels.html#sets=ons`);
        await page.waitForSelector('#cards .card[data-ready="1"]');
        await page.waitForFunction(() => document.getElementById('status').textContent.includes('Set list unavailable'));
        expect((await page.textContent('#cards .card-title')).includes('ONS'), 'card titled with the code');
        expect((await page.textContent('#allSets')).includes('Set list unavailable'), 'list shows the notice');
    }, { allowErrors: /Failed to load resource|ERR_/ }]
];

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
let browser, code = 0;
try {
    browser = await chromium.launch();
    for (const [name, run, opts = {}] of scenarios) {
        const context = await browser.newContext({ acceptDownloads: true });
        const env = { context, sets: { mode: 'ok', requests: 0 } };
        const problems = [];
        let loads = 0;
        await context.route('https://api.scryfall.com/sets', (route) => {
            if (env.sets.mode === 'abort') return route.abort();
            return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(SET_FIXTURE) });
        });
        // Every request must be local or exactly one GET https://api.scryfall.com/sets without query string or body
        context.on('request', (r) => {
            const u = new URL(r.url());
            if (!/^https?:$/.test(u.protocol) || u.origin === base) return;
            const ok = u.origin === 'https://api.scryfall.com' && u.pathname === '/sets' && u.search === '' && r.method() === 'GET' && !r.postData();
            if (ok) env.sets.requests++;
            else problems.push(`unexpected request ${r.method()} ${r.url()}`);
        });
        context.on('page', (p) => {
            p.on('load', () => { loads++; });
            p.on('console', (m) => { if (m.type() === 'error' && !opts.allowErrors?.test(m.text())) problems.push(`console: ${m.text()}`); });
            p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
        });
        const expect = (ok, what) => { if (!ok) throw new Error(`${name}: ${what}`); };
        await run(await context.newPage(), base, expect, env);
        const unexpected = problems.find((p) => p.startsWith('unexpected request'));
        if (unexpected) throw new Error(unexpected);
        expect(problems.length === 0, problems.join('; '));
        expect(env.sets.requests <= loads, `${env.sets.requests} sets requests for ${loads} page loads`);
        await context.close();
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
