// Dev only (not shipped): headless Chromium smoke test of labels/ served over plain HTTP.
// PLAYWRIGHT_CORE=/path/to/playwright-core node tools/smoke-labels.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

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

async function saveDownload(page, action) {
    const [download] = await Promise.all([page.waitForEvent('download'), action()]);
    const chunks = [];
    for await (const c of await download.createReadStream()) chunks.push(c);
    return { name: download.suggestedFilename(), bytes: new Uint8Array(Buffer.concat(chunks)) };
}

const READY = '#cards .card[data-ready="1"]';
// New page on the labels page; reset forgets stored options first so scenarios start from the defaults
async function openLabels(env, base, hash, reset = true) {
    const page = await env.context.newPage();
    await page.goto(`${base}/labels.html${hash}`);
    if (reset) {
        await page.evaluate(() => localStorage.removeItem('cmlp.labels.settings'));
        await page.reload();
    }
    if (hash) await page.waitForSelector(READY);
    return page;
}

// Init scripts (run in the page): one printer model shared by the USB and the serial stub. Writes are recorded in window.__printer.writes;
// a whole-write status request answers with a status frame, a complete job answers with three frames (phase, completed, phase).
function installPrinterModel() {
    const printer = { writes: [], widthMm: 24, queue: [], waiting: null, job: null };
    window.__printer = printer;
    printer.isStatusRequest = (w) => w.length === 105 && w.slice(0, 100).every((b) => b === 0) && w[100] === 0x1b && w[101] === 0x40 && w[102] === 0x1b && w[103] === 0x69 && w[104] === 0x53;
    const startsJob = (b) => b.length >= 121 && b.slice(0, 100).every((x) => x === 0) && [0x1b, 0x40, 0x1b, 0x69, 0x61, 0x01].every((x, i) => b[100 + i] === x);
    const frame = (statusType, phaseType) => {
        const f = new Uint8Array(32);
        f.set([0x80, 0x20, 0x42, 0x30, 0x76, 0x30]);
        f[10] = printer.widthMm;
        f[11] = 1;
        f[18] = statusType;
        f[19] = phaseType;
        return f;
    };
    const push = (...frames) => {
        printer.queue.push(...frames);
        if (printer.waiting && printer.queue.length) {
            const resolve = printer.waiting;
            printer.waiting = null;
            resolve(printer.queue.shift());
        }
    };
    printer.receive = (bytes) => {
        printer.writes.push(bytes);
        if (printer.job) {
            printer.job.seen += bytes.length;
        } else if (printer.isStatusRequest(bytes)) {
            push(frame(0, 0));
        } else if (startsJob(bytes)) {
            const lines = bytes[117] | (bytes[118] << 8) | (bytes[119] << 16) | (bytes[120] << 24);
            printer.job = { seen: bytes.length, total: 139 + 19 * lines };
        }
        if (printer.job && printer.job.seen >= printer.job.total) {
            printer.job = null;
            push(frame(6, 1), frame(1, 0), frame(6, 0));
        }
    };
    printer.nextFrame = () => new Promise((resolve) => { printer.waiting = resolve; push(); });
}

function installUsbStub() {
    const printer = window.__printer;
    const device = {
        vendorId: 0x04f9, productId: 0x20af, configuration: {},
        open: async () => {}, selectConfiguration: async () => {}, claimInterface: async () => {}, releaseInterface: async () => {}, close: async () => {},
        transferOut: async (endpoint, data) => {
            const bytes = Array.from(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength));
            printer.receive(bytes);
            return { status: 'ok', bytesWritten: bytes.length };
        },
        transferIn: () => printer.nextFrame().then((f) => ({ status: 'ok', data: new DataView(f.buffer) }))
    };
    const usb = { requestDevice: async () => device, getDevices: async () => [], addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(navigator, 'usb', { configurable: true, value: usb });
}

const addPrinterStub = (page, stub) => page.addInitScript(`(${installPrinterModel})();(${stub})();`);

// Connect, print one card and compare the bytes after the last status request with a fresh in-page render
async function printAndCompare(page, base, expect, button, status) {
    await page.goto(`${base}/labels.html#sets=ons`);
    await page.waitForSelector(READY);
    expect(await page.locator('button[data-action="print"]').isDisabled(), `Print is disabled before ${button}`);
    await page.click(button);
    await page.waitForFunction((text) => document.getElementById('printerStatus').textContent === text, status);
    await page.click('button[data-action="print"]');
    await page.waitForFunction(() => document.querySelector('.print-state').textContent === 'Printed');
    return page.evaluate(async () => {
        const { writes, isStatusRequest } = window.__printer;
        const last = writes.map(isStatusRequest).lastIndexOf(true);
        const { bitmap } = await renderFresh(state.ticked.get('ons'));
        return {
            actual: writes.slice(last + 1).flat(), expected: Array.from(PTouch.buildJob(bitmap, { cut: true })),
            requests: writes.filter(isStatusRequest).length
        };
    });
}

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
    ['designer', async (page0, base, expect, env) => {
        const inkOf = (png) => { const a = []; for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) a.push(png.ink(x, y)); return a; };
        const inkRange = (png, x0, x1, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += png.ink(x, y); return n; };
        const png = async (page) => readPng((await saveDownload(page, () => page.click('button[data-action="download"]'))).bytes);

        // (a) caption and 1x pixelated preview
        let page = await openLabels(env, base, '#sets=ons');
        expect(/^\d+ x 18 mm printable \(24 mm tape\)$/.test(await page.textContent('.caption')), `caption ${await page.textContent('.caption')}`);
        const view = await page.evaluate(() => {
            const c = document.querySelector('canvas.preview'), css = getComputedStyle(c);
            return { w: c.width, cssW: css.width, cssH: css.height, ir: css.imageRendering };
        });
        expect(view.cssW === `${view.w}px` && view.cssH === '128px' && view.ir === 'pixelated', `preview ${JSON.stringify(view)}`);

        // (b) preview ink equals PNG ink
        const shown = await page.evaluate(() => {
            const c = document.querySelector('canvas.preview');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            const out = [];
            for (let i = 0; i < d.length; i += 4) out.push(d[i] < 128 ? 1 : 0);
            return out;
        });
        const first = await png(page);
        const printed = inkOf(first);
        expect(printed.length === shown.length && printed.every((v, i) => v === shown[i]), 'PNG ink differs from the preview');
        expect(printed.some((v) => v === 1), 'PNG has no ink');

        // (c) file names
        await page.check('.card input.foil');
        await page.selectOption('.card select.cond', 'NM');
        await page.waitForSelector(READY);
        let saved = await saveDownload(page, () => page.click('button[data-action="download"]'));
        expect(saved.name === 'ons-onslaught-foil-nm.png', `name ${saved.name}`);
        await page.uncheck('.card input.foil');
        await page.selectOption('.card select.cond', 'none');
        await page.waitForSelector(READY);
        saved = await saveDownload(page, () => page.click('button[data-action="download"]'));
        expect(saved.name === 'ons-onslaught.png', `name ${saved.name}`);

        // (d) set without a glyph
        page = await openLabels(env, base, '#sets=trk');
        expect((await page.textContent('ul.notices')).includes('No Keyrune icon'), 'no-glyph notice');
        expect(inkRange(await png(page), 0, 100, 0, 128) > 0, 'text-only PNG has no ink');
        await page.uncheck('#optIcon');
        await page.waitForSelector(READY);
        expect(await page.locator('ul.notices li').count() === 0, 'notice stays with the icon off');

        // (e) max length: a long name breaks and shrinks to fit; an impossible length warns
        page = await openLabels(env, base, '#sets=clb');
        await page.fill('#maxMm', '70');
        await page.waitForSelector(READY);
        let p = await png(page);
        expect(p.width <= 496, `max 70 mm width ${p.width}`);
        expect(await page.locator('ul.notices li').count() === 0, 'no notice when the name fits 70 mm');
        await page.fill('#maxMm', '26');
        await page.waitForSelector(READY);
        expect((await page.textContent('ul.notices')).includes('longer than 26 mm'), 'over-max notice names the set length');

        // (f) the longest name is not clipped at automatic length
        page = await openLabels(env, base, '#sets=tmt');
        p = await png(page);
        expect(p.width <= 709, `tmt width ${p.width}`);
        expect(inkRange(p, p.width - 8, p.width, 0, 128) === 0, 'ink in the last 8 columns');
        expect(inkRange(p, 0, p.width, 0, 4) === 0 && inkRange(p, 0, p.width, 124, 128) === 0, 'ink in the top or bottom 4 rows');

        // (g) nothing to show
        page = await openLabels(env, base, '#sets=ons');
        for (const id of ['#optIcon', '#optName', '#optCode']) await page.uncheck(id);
        await page.waitForSelector(READY);
        expect((await page.textContent('ul.notices')).includes('Nothing to show'), 'empty notice');
        expect(await page.locator('button[data-action="download"]').isDisabled(), 'card download disabled');
        expect(await page.locator('#downloadAll').isDisabled(), 'download all disabled');

        // (h) ZIP in card order
        page = await openLabels(env, base, '#sets=clb,dom,ons');
        await page.waitForFunction(() => document.querySelectorAll('#cards .card[data-ready="1"]').length === 3);
        await page.check('.card[data-code="ons"] input.foil');
        await page.selectOption('.card[data-code="ons"] select.cond', 'NM');
        await page.waitForSelector('.card[data-code="ons"][data-ready="1"]');
        const zip = await saveDownload(page, () => page.click('#downloadAll'));
        expect(zip.name === 'edition-labels.zip', `zip name ${zip.name}`);
        const dir = await mkdtemp(join(tmpdir(), 'smoke-labels-'));
        try {
            const file = join(dir, zip.name);
            await writeFile(file, zip.bytes);
            const names = execFileSync('unzip', ['-Z1', file]).toString().trim().split('\n');
            expect(names.join() === 'ons-onslaught-foil-nm.png,dom-dominaria.png,clb-commander-legends-battle-for-baldurs-gate.png', `zip entries ${names}`);
            execFileSync('unzip', ['-tq', file]);
            for (const n of names) {
                const entry = readPng(new Uint8Array(execFileSync('unzip', ['-p', file, n], { maxBuffer: 1 << 24 })));
                expect(entry.height === 128, `${n} height ${entry.height}`);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }

        // (i) options survive a reload, no set is ticked, last foil and condition become the defaults
        page = await openLabels(env, base, '#sets=ons');
        await page.uncheck('#optName');
        await page.fill('#maxMm', '50');
        await page.check('.card input.foil');
        await page.selectOption('.card select.cond', 'NM');
        await page.waitForSelector(READY);
        const again = await openLabels(env, base, '', false);
        await again.waitForSelector('#allSets .set-row');
        expect(!(await again.isChecked('#optName')) && await again.isChecked('#optIcon') && await again.isChecked('#optCode'), 'switches restored');
        expect(await again.inputValue('#maxMm') === '50', 'max length restored');
        expect(await again.locator('.card').count() === 0, 'no card after reload');
        await again.check('#allSets input[data-code="dom"]');
        await again.waitForSelector(READY);
        expect(await again.isChecked('.card input.foil') && await again.inputValue('.card select.cond') === 'NM', 'defaults for a new card');
    }],
    ['csv', async (page0, base, expect, env) => {
        const rows = [
            { setCode: 'ONS', setName: 'Onslaught', binder: 'Binder A', name: 'SENTINEL-CSV-ROW', qty: 99, price: 7777.77 },
            { setCode: 'DOM', setName: 'Dominaria', binder: 'Binder A', name: 'Other Card', qty: 1, price: 0.5 },
            { setCode: 'MOM', setName: 'March of the Machine', binder: 'Binder B', name: 'Elsewhere', qty: 1, price: 0.5 },
            { setCode: 'Ons', setName: 'Onslaught again', binder: 'Binder A', name: 'Duplicate', qty: 2, price: 0.5 }
        ];
        const csvs = { a: { id: 'a', binder: 'Binder A', rows } };
        const quiet = () => new Promise((r) => setTimeout(r, 200));

        // Variant A: full fake storage
        const page = await env.context.newPage();
        await page.addInitScript((data) => { window.chrome = { storage: { local: { get: async () => ({ csvs: data, activeFile: 'a' }) } } }; }, csvs);
        await page.goto(`${base}/labels.html`);
        await page.waitForSelector('#allSets .set-row');
        await page.waitForFunction(() => [...document.querySelectorAll('#csvSets .set-row')].map((r) => r.dataset.code).join() === 'ons,dom');
        expect(await page.locator('#csvSection').isVisible(), 'CSV section visible');
        expect((await rowCodes(page, 'csvSets')).join() === 'ons,dom', `csv rows ${await rowCodes(page, 'csvSets')}`);
        expect((await page.textContent('#csvSets .set-row[data-code="ons"] .name')) === 'Onslaught', 'csv name resolved');
        await page.click('#csvSets input[data-code="ons"]');
        expect(await page.isChecked('#allSets input[data-code="ons"]'), 'ticking in the CSV list ticks the all-sets list');
        await page.waitForSelector(READY);
        await page.check('.card input.foil');
        await page.uncheck('#optName');
        await page.waitForSelector(READY);
        const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
        const keys = Object.keys(stored).sort();
        expect(keys.every((k) => ['cmlp.labels.settings', 'cmlp.labels.sets'].includes(k)), `localStorage keys ${keys}`);
        const dump = JSON.stringify(stored);
        expect(!dump.includes('SENTINEL-CSV-ROW') && !dump.includes('7777') && !/qty|price/i.test(dump), 'CSV data reached localStorage');

        // Variants B (bare chrome object), C (rejected read), D (no chrome at all): fragment fallback, no errors
        const variants = {
            bare: () => { window.chrome = {}; },
            rejecting: () => { window.chrome = { storage: { local: { get: () => Promise.reject(new Error('denied')) } } }; },
            none: () => { delete window.chrome; }
        };
        for (const [name, init] of Object.entries(variants)) {
            const p = await env.context.newPage();
            await p.addInitScript(init);
            await p.goto(`${base}/labels.html#sets=ons`);
            await p.waitForSelector(READY);
            await quiet();
            expect(await p.locator('#csvSection').isHidden(), `${name}: CSV section stays hidden`);
            expect(await p.locator('#cards .card').count() === 1, `${name}: fragment still works`);
        }
    }],
    ['usb-print', async (page, base, expect) => {
        await addPrinterStub(page, installUsbStub);
        const sent = await printAndCompare(page, base, expect, '#connectUsb', 'USB printer connected. 24 mm tape loaded.');
        expect(sent.actual.length === sent.expected.length && sent.actual.every((b, i) => b === sent.expected[i]), `job bytes differ (${sent.actual.length} sent, ${sent.expected.length} expected)`);
        expect(sent.requests >= 2, `status requests ${sent.requests}`);

        // a 12 mm cassette: Print fails before any job byte
        await page.evaluate(() => { window.__printer.widthMm = 12; window.__printer.mark = window.__printer.writes.length; });
        await page.click('button[data-action="print"]');
        await page.waitForFunction(() => document.querySelector('.print-state').textContent.startsWith('Failed'));
        const text = await page.textContent('.print-state');
        expect(text.includes('12 mm') && text.includes('24 mm'), `mismatch text ${text}`);
        const rasterWritten = await page.evaluate(() => {
            const bytes = window.__printer.writes.slice(window.__printer.mark).flat();
            return bytes.some((b, i) => b === 0x47 && bytes[i + 1] === 0x10 && bytes[i + 2] === 0x00);
        });
        expect(!rasterWritten, 'a raster line was written for the wrong tape');
        expect(!(await page.locator('button[data-action="print"]').isDisabled()), 'page is usable after a failed print');
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
    const only = (process.env.SMOKE_ONLY || '').split(',').map((n) => n.trim()).filter(Boolean);
    const selected = only.length ? scenarios.filter(([n]) => only.includes(n)) : scenarios;
    if (only.length && !selected.length) throw new Error('no scenario matches SMOKE_ONLY');
    browser = await chromium.launch();
    for (const [name, run, opts = {}] of selected) {
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
