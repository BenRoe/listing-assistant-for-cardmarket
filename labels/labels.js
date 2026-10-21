// Label page: set picker (CSV sets, Scryfall list, #sets= fragment), global options, and one card per ticked set.
// Each card previews the exact 1-bit bitmap that gets exported. All page data reaches the DOM through textContent only.
const CODE_SAMPLE_FONT = '700 44px Cinzel';
const SETS_TTL_MS = 24 * 60 * 60 * 1000;
const NOTICE_TEXT = {
    'no-glyph': 'No Keyrune icon exists for this set, so the label has no icon.',
    'empty': 'Nothing to show: switch on the icon, name or code.',
    'over-max': () => `The label is longer than ${state.settings.maxMm ?? 100} mm.`
};

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
        showIcon: s.icon, showName: s.name, showCode: s.code, maxMm: s.maxMm ?? undefined,
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
    const head = Object.assign(document.createElement('div'), { className: 'card-head' });
    const title = Object.assign(document.createElement('h2'), { className: 'card-title' });
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove' });
    remove.dataset.action = 'remove';
    remove.addEventListener('click', () => toggleSet(rec.code, false));
    head.append(title, remove);

    const foil = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'foil', checked: rec.foil });
    const foilLabel = document.createElement('label');
    foilLabel.append(foil, ' Foil');
    const cond = Object.assign(document.createElement('select'), { className: 'cond' });
    for (const c of ['none', ...LabelCore.CONDITIONS]) cond.append(Object.assign(document.createElement('option'), { value: c, textContent: c }));
    cond.value = rec.cond;
    const condLabel = document.createElement('label');
    condLabel.append('Condition ', cond);
    const options = Object.assign(document.createElement('div'), { className: 'card-options' });
    options.append(foilLabel, condLabel);
    // foil and condition are per card; the last used values become the defaults of newly ticked sets (D-13)
    const changed = () => {
        rec.foil = foil.checked;
        rec.cond = LabelCore.normalizeCondition(cond.value);
        state.settings = { ...state.settings, foil: rec.foil, cond: rec.cond };
        saveSettings();
        PrintUI.cardChanged(rec);   // the label changed, so earlier prints of this card no longer count
        renderCard(rec).catch((e) => showError(rec, e));
    };
    foil.addEventListener('change', changed);
    cond.addEventListener('change', changed);

    const strip = Object.assign(document.createElement('div'), { className: 'strip' });
    strip.append(Object.assign(document.createElement('canvas'), { className: 'preview' }));
    const caption = Object.assign(document.createElement('p'), { className: 'caption' });
    const notices = Object.assign(document.createElement('ul'), { className: 'notices' });
    const download = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Download PNG' });
    download.dataset.action = 'download';
    download.addEventListener('click', () => downloadOne(rec.code).catch((e) => showError(rec, e)));
    const actions = Object.assign(document.createElement('div'), { className: 'card-actions' });
    actions.append(download, ...PrintUI.cardControls(rec));
    card.append(head, options, strip, caption, notices, actions);
    return card;
}

function setNotices(rec, texts) {
    rec.el.querySelector('ul.notices').replaceChildren(...texts.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
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
    canvas.style.width = `${bitmap.width}px`;
    canvas.style.height = `${bitmap.height}px`;
    canvas.getContext('2d').putImageData(new ImageData(LabelCore.bitmapToRgba(bitmap), bitmap.width, bitmap.height), 0, 0);
    rec.el.querySelector('.caption').textContent = LabelCore.captionFor(bitmap.width);
    setNotices(rec, layout.warnings.map((w) => (typeof NOTICE_TEXT[w] === 'function' ? NOTICE_TEXT[w]() : NOTICE_TEXT[w])));
    rec.el.querySelector('button[data-action="download"]').disabled = layout.empty;
    rec.el.dataset.ready = '1';
    updateChrome();
}

function reorderCards() {
    const order = LabelCore.sortSets([...state.ticked.keys()].map(currentSet)).map((s) => s.code);
    $('cards').append(...order.map((code) => state.ticked.get(code).el));
}

function updateChrome() {
    $('empty').hidden = state.ticked.size > 0;
    $('downloadAll').disabled = state.building || ![...state.ticked.values()].some((r) => r.result && !r.result.layout.empty);
    PrintUI.refresh();   // renderCard ends with updateChrome, so a finished render also refreshes the Print buttons
}

function toggleSet(code, on) {
    if (on === state.ticked.has(code)) return;
    if (on) {
        const rec = { code, foil: state.settings.foil, cond: state.settings.cond, copies: state.settings.copies, printed: 0, seq: 0, result: null, el: null };
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
    setNotices(rec, [`Render failed: ${e.message || e}`]);
}

function renderAllCards() {
    for (const rec of state.ticked.values()) renderCard(rec).catch((e) => showError(rec, e));
}

function renderAll() {
    renderLists();
    reorderCards();
    renderAllCards();
}

async function renderFresh(rec) {
    const set = currentSet(rec.code);
    const { bitmap, layout } = await renderBitmap(set, rec);   // fresh render, never a cached bitmap
    return { bitmap, layout, name: LabelCore.fileName({ code: rec.code, name: set.name, foil: rec.foil, cond: rec.cond }) };
}

async function downloadOne(code) {
    const { bitmap, name } = await renderFresh(state.ticked.get(code));
    downloadBytes(LabelCore.encodePng1bit(bitmap, LabelCore.DPI), name, 'image/png');
}

// One ZIP built fully in memory and saved as one download; the flag ignores clicks while a build runs
async function downloadAll() {
    if (state.building) return;
    state.building = true;
    setNote('zip', '');
    updateChrome();
    try {
        const files = [];
        for (const el of [...$('cards').children]) {
            const rec = state.ticked.get(el.dataset.code);
            const fresh = await renderFresh(rec);
            if (!fresh.layout.empty) files.push({ name: fresh.name, data: LabelCore.encodePng1bit(fresh.bitmap, LabelCore.DPI) });
        }
        if (!files.length) return;
        const names = LabelCore.uniqueNames(files.map((f) => f.name));
        downloadBytes(LabelCore.zipStore(files.map((f, i) => ({ name: names[i], data: f.data }))), 'edition-labels.zip', 'application/zip');
    } catch (e) {
        setNote('zip', `ZIP failed: ${e.message || e}`);
    } finally {
        state.building = false;
        updateChrome();
    }
}

// ---- global options -----------------------------------------------------------------------------

function applySettingsToControls() {
    const s = state.settings;
    $('optIcon').checked = s.icon;
    $('optName').checked = s.name;
    $('optCode').checked = s.code;
    $('maxMm').value = s.maxMm === null ? '' : String(s.maxMm);
    $('optCut').checked = s.cut;
}

function readControls(writeBack) {
    const rawMax = $('maxMm').value.trim();
    state.settings = LabelCore.normalizeSettings({
        ...state.settings,
        icon: $('optIcon').checked, name: $('optName').checked, code: $('optCode').checked,
        maxMm: rawMax === '' ? null : Number(rawMax)
    });
    if (writeBack) applySettingsToControls();
    saveSettings();
    renderAllCards();
}

// ---- start --------------------------------------------------------------------------------------

(function init() {
    loadSettings();
    applySettingsToControls();
    PrintUI.init({
        $, renderFresh,
        records: () => [...$('cards').children].map((el) => state.ticked.get(el.dataset.code)),   // ticked cards in card order
        settings: () => state.settings,
        updateSettings: (patch) => {
            state.settings = LabelCore.normalizeSettings({ ...state.settings, ...patch });
            saveSettings();
            return state.settings;
        }
    });
    for (const id of ['optIcon', 'optName', 'optCode']) $(id).addEventListener('change', () => readControls(false));
    $('maxMm').addEventListener('input', () => readControls(false));
    $('maxMm').addEventListener('change', () => readControls(true));
    $('downloadAll').addEventListener('click', downloadAll);
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
