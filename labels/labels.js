// Label page: set picker (CSV sets, Scryfall list, #sets= fragment), global options, and one card per ticked set.
// Each card previews the exact 1-bit bitmap that gets exported. All page data reaches the DOM through textContent only.
const CODE_SAMPLE_FONT = '700 44px Cinzel';
const SETS_TTL_MS = 24 * 60 * 60 * 1000;

const state = {
    settings: LabelCore.normalizeSettings(null),
    list: [],
    listState: 'loading',
    showAll: false,
    query: '',
    csv: null,
    ticked: new Map(),   // code -> card record
    building: false
};
const $ = (id) => document.getElementById(id);

// ---- status line -------------------------------------------------------------------------------

const notes = {};
function setNote(key, text) {
    notes[key] = text;
    $('status').textContent = Object.values(notes).filter(Boolean).join(' ');
}

// ---- stored data: preferences and the public set list only --------------------------------------

function loadSettings() {
    try {
        state.settings = LabelCore.normalizeSettings(JSON.parse(localStorage.getItem('cmlp.labels.settings')));
    } catch {
        state.settings = LabelCore.normalizeSettings(null);
    }
}

function saveSettings() {
    try {
        localStorage.setItem('cmlp.labels.settings', JSON.stringify(state.settings));
        setNote('storage', '');
    } catch {
        setNote('storage', 'Options could not be remembered (storage is disabled or full).');
    }
}

function readSetCache() {
    try {
        const { at, sets } = JSON.parse(localStorage.getItem('cmlp.labels.sets'));
        return Number.isFinite(at) ? { at, sets: LabelCore.trimSets(sets) } : null;
    } catch {
        return null;
    }
}

function writeSetCache(sets) {
    try {
        localStorage.setItem('cmlp.labels.sets', JSON.stringify({ at: Date.now(), sets }));
    } catch {
        setNote('storage', 'The set list could not be cached (storage is disabled or full).');
    }
}

// ---- Scryfall set list: one GET per visit at most, cached 24 h ----------------------------------

async function fetchSets() {
    const res = await fetch('https://api.scryfall.com/sets', { headers: { Accept: 'application/json' }, credentials: 'omit' });
    if (!res.ok) throw Object.assign(new Error('Scryfall HTTP ' + res.status), { status: res.status });
    return LabelCore.trimSets(await res.json());
}

async function loadSetList(cache) {
    if (cache && Date.now() - cache.at < SETS_TTL_MS) return;
    try {
        const sets = await fetchSets();
        writeSetCache(sets);
        state.list = sets;
        state.listState = 'ready';
        setNote('sets', '');
    } catch (e) {
        state.listState = state.list.length ? 'ready' : 'failed';
        setNote('sets', 'Set list unavailable (offline?). CSV sets and #sets= still work.' + (e.status === 429 ? ' Scryfall is rate limiting (HTTP 429), try again in a minute.' : ''));
    }
    renderAll();
}

// ---- picker -------------------------------------------------------------------------------------

const currentSet = (code) => LabelCore.resolveSet(state.list, code, state.csv?.find((s) => s.code === code)?.name);

function setRow(set) {
    const li = document.createElement('li');
    const row = document.createElement('label');
    row.className = 'set-row';
    row.dataset.code = set.code;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.code = set.code;
    box.checked = state.ticked.has(set.code);
    const code = Object.assign(document.createElement('span'), { className: 'code', textContent: set.code.toUpperCase() });
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: set.name });
    const date = Object.assign(document.createElement('span'), { className: 'date', textContent: set.released_at ?? '' });
    row.append(box, code, name, date);
    li.append(row);
    return li;
}

function fillList(ul, sets, emptyText) {
    if (!sets.length) {
        const li = Object.assign(document.createElement('li'), { className: 'set-note', textContent: emptyText });
        ul.replaceChildren(li);
        return;
    }
    ul.replaceChildren(...sets.map(setRow));
}

function renderLists() {
    const all = LabelCore.searchSets(LabelCore.sortSets(LabelCore.filterSets(state.list, state.showAll)), state.query);
    let emptyText = 'No sets match';
    if (!state.list.length) emptyText = state.listState === 'loading' ? 'Loading sets...' : 'Set list unavailable';
    fillList($('allSets'), all, emptyText);

    const csv = state.csv ?? [];
    $('csvSection').hidden = csv.length === 0;
    fillList($('csvSets'), LabelCore.searchSets(LabelCore.sortSets(csv.map((s) => currentSet(s.code))), state.query), 'No sets match');
}

function syncChecks() {
    for (const box of document.querySelectorAll('#picker input[data-code]')) box.checked = state.ticked.has(box.dataset.code);
}

// ---- rendering a label --------------------------------------------------------------------------

function drawOps(ctx, ops) {
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    for (const op of ops) {
        if (op.type === 'box') {
            ctx.lineWidth = op.lineWidth;
            ctx.beginPath();
            ctx.roundRect(op.x, op.y, op.w, op.h, op.radius);
            ctx.stroke();
        } else {
            ctx.font = op.font;
            ctx.fillText(op.text, op.x, op.y);
        }
    }
}

function measureWith(ctx) {
    return (font, text) => {
        ctx.font = font;
        const m = ctx.measureText(text);
        return {
            width: m.width,
            ascent: m.actualBoundingBoxAscent,
            descent: m.actualBoundingBoxDescent,
            left: m.actualBoundingBoxLeft,
            right: m.actualBoundingBoxRight
        };
    };
}

async function renderBitmap(set, rec) {
    const glyph = LabelCore.glyphFor(KEYRUNE, set.code);
    await Promise.all([
        glyph === null ? null : document.fonts.load('100px Keyrune', String.fromCodePoint(glyph)),
        document.fonts.load(CODE_SAMPLE_FONT, 'Aa')
    ]);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const s = state.settings;
    const layout = LabelCore.layoutLabel({
        code: set.code, name: set.name, glyph,
        showIcon: s.icon, showName: s.name, showCode: s.code, fixedMm: s.fixedMm,
        foil: rec.foil, cond: rec.cond
    }, measureWith(ctx));
    canvas.width = layout.width;
    canvas.height = layout.height;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, layout.width, layout.height);
    drawOps(ctx, layout.ops);
    return { bitmap: LabelCore.toBitmap(ctx.getImageData(0, 0, layout.width, layout.height).data, layout.width, layout.height), layout };
}

function downloadBytes(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- cards --------------------------------------------------------------------------------------

function buildCard(rec) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.code = rec.code;
    const title = Object.assign(document.createElement('h2'), { className: 'card-title' });
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove' });
    remove.dataset.action = 'remove';
    remove.addEventListener('click', () => toggleSet(rec.code, false));
    const strip = Object.assign(document.createElement('div'), { className: 'strip' });
    const canvas = Object.assign(document.createElement('canvas'), { className: 'preview' });
    strip.append(canvas);
    const download = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Download PNG' });
    download.dataset.action = 'download';
    download.addEventListener('click', () => downloadOne(rec.code));
    card.append(title, remove, strip, download);
    return card;
}

async function renderCard(rec) {
    const seq = ++rec.seq;   // an older async render must not overwrite a newer one
    delete rec.el.dataset.ready;
    const set = currentSet(rec.code);
    rec.el.querySelector('.card-title').textContent = `${set.code.toUpperCase()} ${set.name}`;
    const { bitmap, layout } = await renderBitmap(set, rec);
    if (seq !== rec.seq) return;
    rec.result = { bitmap, layout };
    const canvas = rec.el.querySelector('canvas.preview');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.style.width = `${bitmap.width * 3}px`;
    canvas.style.height = `${bitmap.height * 3}px`;
    canvas.getContext('2d').putImageData(new ImageData(LabelCore.bitmapToRgba(bitmap), bitmap.width, bitmap.height), 0, 0);
    rec.el.dataset.ready = '1';
}

function reorderCards() {
    const order = LabelCore.sortSets([...state.ticked.keys()].map(currentSet)).map((s) => s.code);
    $('cards').append(...order.map((code) => state.ticked.get(code).el));
}

function updateChrome() {
    $('empty').hidden = state.ticked.size > 0;
}

function toggleSet(code, on) {
    if (on === state.ticked.has(code)) return;
    if (on) {
        const rec = { code, foil: state.settings.foil, cond: state.settings.cond, seq: 0, result: null, el: null };
        rec.el = buildCard(rec);
        state.ticked.set(code, rec);
        $('cards').append(rec.el);
        reorderCards();
        renderCard(rec).catch((e) => showError(rec, e));
    } else {
        state.ticked.get(code).el.remove();
        state.ticked.delete(code);
    }
    syncChecks();
    updateChrome();
}

function showError(rec, e) {
    rec.el.querySelector('.card-title').textContent += ` (render failed: ${e.message || e})`;
}

function renderAllCards() {
    for (const rec of state.ticked.values()) renderCard(rec).catch((e) => showError(rec, e));
}

function renderAll() {
    renderLists();
    reorderCards();
    renderAllCards();
}

async function downloadOne(code) {
    const rec = state.ticked.get(code);
    const set = currentSet(code);
    const { bitmap } = await renderBitmap(set, rec);   // fresh render, never a cached bitmap
    const name = LabelCore.fileName({ code, name: set.name, foil: rec.foil, cond: rec.cond });
    downloadBytes(LabelCore.encodePng1bit(bitmap, LabelCore.DPI), name, 'image/png');
}

// ---- global options -----------------------------------------------------------------------------

function applySettingsToControls() {
    const s = state.settings;
    $('optIcon').checked = s.icon;
    $('optName').checked = s.name;
    $('optCode').checked = s.code;
    $('fixedMm').value = s.fixedMm === null ? '' : String(s.fixedMm);
}

function readControls(writeBack) {
    const raw = $('fixedMm').value.trim();
    state.settings = LabelCore.normalizeSettings({
        ...state.settings,
        icon: $('optIcon').checked, name: $('optName').checked, code: $('optCode').checked,
        fixedMm: raw === '' ? null : Number(raw)
    });
    if (writeBack) applySettingsToControls();
    saveSettings();
    renderAllCards();
}

// ---- start --------------------------------------------------------------------------------------

(function init() {
    loadSettings();
    applySettingsToControls();
    for (const id of ['optIcon', 'optName', 'optCode']) $(id).addEventListener('change', () => readControls(false));
    $('fixedMm').addEventListener('input', () => readControls(false));
    $('fixedMm').addEventListener('change', () => readControls(true));
    $('search').addEventListener('input', (e) => { state.query = e.target.value; renderLists(); });
    $('showAll').addEventListener('change', (e) => { state.showAll = e.target.checked; renderLists(); });
    for (const id of ['csvSets', 'allSets']) {
        $(id).addEventListener('change', (e) => {
            if (e.target.matches('input[data-code]')) toggleSet(e.target.dataset.code, e.target.checked);
        });
    }

    const cache = readSetCache();
    if (cache) {
        state.list = cache.sets;
        state.listState = 'ready';
    }
    for (const code of LabelCore.parseFragment(location.hash)) toggleSet(code, true);
    renderLists();
    updateChrome();

    loadSetList(cache);
    readCsvSets(LabelCore.groupCsvSets).then((sets) => {
        if (!sets || !sets.length) return;
        state.csv = sets;
        renderAll();
    });
})();
