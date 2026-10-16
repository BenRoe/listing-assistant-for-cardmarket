(function () {
    const ext = globalThis.browser ?? globalThis.chrome;
    const { CONDITION_ID, LANGUAGE_ID, DEFAULT_SETTINGS, buildRows, formatPrice, computePrice, buildSearchUrl } = CMLP;

    // Every Cardmarket DOM assumption lives here.
    const SEL = {
        mount: 'main.container',
        form: 'form#ListProductForm',
        sellTab: 'a[href="#tabContent-sell"]',
        sellPane: '#tabContent-sell',
        offerRow: '.article-row[id^="articleRow"]',
        offerPrice: '.price-container',
        ownRow: '[id^="stockRow"]',
        successAlert: '.systemMessage.alert-success'
    };
    const SUBMIT_KEY = 'cmlp.submitAt';
    const SUBMIT_WINDOW = 60 * 1000;
    const FILL_MAX_AGE = 10 * 60 * 1000;
    const BATCH = 75;

    const state = {
        files: {}, rows: [], activeFile: '', scry: {}, done: {}, active: null,
        settings: { ...DEFAULT_SETTINGS },
        filter: '', binder: '', hideDone: false, collapsed: false, status: ''
    };
    let ui = {};

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function waitFor(fn, timeout) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            const v = fn();
            if (v) return v;
            await sleep(100);
        }
        return null;
    }

    function el(tag, props, ...children) {
        const e = document.createElement(tag);
        Object.assign(e, props);
        for (const c of children) e.append(c);
        return e;
    }

    // ---- storage -------------------------------------------------------------------------

    async function loadState() {
        const s = await ext.storage.local.get(['csvs', 'activeFile', 'scryfall', 'done', 'settings', 'collapsed', 'active']);
        state.files = s.csvs || {};
        state.scry = s.scryfall || {};
        state.done = s.done || {};
        state.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
        state.collapsed = !!s.collapsed;
        state.active = s.active || null;
        selectFile(state.files[s.activeFile] ? s.activeFile : Object.keys(state.files)[0] || '');
    }

    function selectFile(name) {
        state.activeFile = name;
        state.rows = state.files[name]?.rows || [];
        state.binder = state.files[name]?.binder ?? '';
        ext.storage.local.set({ activeFile: name });
    }

    const allRows = () => Object.values(state.files).flatMap((f) => f.rows);

    const binders = () => [...new Set(state.rows.map((r) => r.binder).filter(Boolean))];
    const saveFiles = () => ext.storage.local.set({ csvs: state.files, activeFile: state.activeFile });
    const saveDone = () => ext.storage.local.set({ done: state.done });
    const saveActive = () => ext.storage.local.set({ active: state.active });

    // ---- CSV + Scryfall ------------------------------------------------------------------

    async function importCsv(file) {
        const text = await file.text();
        const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
        // Same file name loaded before: overwrite it (keeps its listed flags) or keep both as separate copies.
        const same = Object.values(state.files).filter((f) => f.fileName === file.name).sort((a, b) => b.loadedAt - a.loadedAt)[0];
        const overwrite = !!same && confirm(`"${file.name}" is already loaded.\n\nOK: overwrite it (its listed flags are kept).\nCancel: load it as a separate copy with its own listed flags.`);
        const id = overwrite ? same.id : String(Date.now());
        const label = overwrite ? same.label : same ? `${file.name} (${new Date().toLocaleString()})` : file.name;
        const { rows, skipped } = buildRows(parsed.data, id);
        if (!rows.length) {
            setStatus('No usable rows: expected a ManaBox CSV with "Name" and "Scryfall ID" columns.');
            return;
        }
        // Loading a file with an existing name replaces that file only; its done flags stay.
        // A collection export repeats cards per binder; listing all of them would double every card.
        const first = [...new Set(rows.map((r) => r.binder).filter(Boolean))][0] || '';
        state.files[id] = { id, fileName: file.name, label, loadedAt: Date.now(), rows, binder: first };
        selectFile(id);
        await saveFiles();
        setStatus(`Loaded ${rows.length} rows from ${file.name}` + (skipped ? ` (${skipped} skipped)` : '') + '.');
        render();
        await resolveScryfall();
    }

    async function resolveScryfall() {
        const missing = [...new Set(allRows().map((r) => r.scryfallId))].filter((id) => !(id in state.scry));
        for (let i = 0; i < missing.length; i += BATCH) {
            setStatus(`Looking up Cardmarket IDs ${Math.min(i + BATCH, missing.length)}/${missing.length}...`);
            const res = await ext.runtime.sendMessage({ type: 'scryfallCollection', ids: missing.slice(i, i + BATCH) });
            if (!res?.ok) {
                setStatus(`Scryfall lookup failed: ${res?.error || 'no response'}. Reload the CSV to retry.`);
                return;
            }
            Object.assign(state.scry, res.cards);
            await ext.storage.local.set({ scryfall: state.scry });
            render();
            await sleep(120);
        }
        if (missing.length) setStatus('Ready. Click "Search" on a card.');
    }

    async function removeCsv() {
        const file = state.files[state.activeFile];
        if (!file || !confirm(`Remove ${file.label} and its listed flags?`)) return;
        const prefix = `${file.id}|`;
        for (const key of Object.keys(state.done)) if (key.startsWith(prefix)) delete state.done[key];
        await saveDone();
        delete state.files[file.id];
        selectFile(Object.keys(state.files)[0] || '');
        await saveFiles();
        setStatus('CSV and its listed flags removed.');
        render();
    }

    // ---- search + fill -------------------------------------------------------------------

    async function search(row) {
        const info = state.scry[row.scryfallId];
        if (!info?.idProduct) { setStatus(`${row.name}: no Cardmarket ID.`); return; }
        state.active = { key: row.key, idProduct: String(info.idProduct), filled: false, at: Date.now() };
        await saveActive();
        const lang = location.pathname.split('/')[1] || 'en';
        location.href = buildSearchUrl(row, info.idProduct, lang);
    }

    function setField(field, value) {
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setChecked(field, checked) {
        field.checked = checked;
        field.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setSelect(select, id, notes, label) {
        if (id && [...select.options].some((o) => o.value === String(id))) {
            setField(select, id);
        } else {
            notes.push(`${label} not available`);
        }
    }

    // Runs on the product page after "Search": fills the Sell tab form from the CSV row.
    async function resumeFill() {
        const a = state.active;
        if (!a || a.filled || Date.now() - a.at > FILL_MAX_AGE) return;
        const form = document.querySelector(SEL.form);
        if (!form || form.elements.idAddProduct?.value !== a.idProduct) return;
        const row = allRows().find((r) => r.key === a.key);
        if (!row) return;

        // The Sell tab is not necessarily the one Cardmarket opens by default.
        const pane = document.querySelector(SEL.sellPane);
        if (pane && !pane.offsetParent) document.querySelector(SEL.sellTab)?.click();

        const f = form.elements;
        const notes = [];
        setField(f.amount, row.qty);
        setSelect(f.idLanguage, LANGUAGE_ID[row.language], notes, `language "${row.language}"`);
        setSelect(f.idCondition, CONDITION_ID[row.condition], notes, `condition "${row.condition}"`);

        const isFoil = row.foil === 'foil' || row.foil === 'etched';
        if (f.isFoil) setChecked(f.isFoil, isFoil);
        else if (isFoil) notes.push('foil not available');
        if (row.foil === 'etched') notes.push('etched filled as foil');
        if (f.isSigned) setChecked(f.isSigned, row.signed);
        if (f.isAltered) setChecked(f.isAltered, row.altered);
        if (f.saveSettings) setChecked(f.saveSettings, false);
        if (row.misprint && state.settings.commentMisprint) setField(f.comments, 'Misprint');

        // Price: the offers shown for the applied filter (language, condition, foil of this row).
        await waitFor(() => document.querySelector(SEL.offerRow), 5000);
        const offers = [...document.querySelectorAll(SEL.offerRow)]
            .map((r) => r.querySelector(SEL.offerPrice)?.textContent || '');
        const price = computePrice(state.settings, offers);
        let priceNote = '';
        if (state.settings.priceSource === 'none') {
            priceNote = '';
        } else if (price == null) {
            notes.push('no offers match the filter, enter the price by hand');
        } else {
            setField(f.price, formatPrice(price));
            priceNote = ` Price ${formatPrice(price)} € (${state.settings.priceSource} of ${offers.length} offers).`;
        }

        state.active.filled = true;
        await saveActive();
        f.price.focus();
        setStatus(`Filled ${row.name}.${priceNote} Check the form and press "Put for sale".` + (notes.length ? ` Note: ${notes.join('; ')}.` : ''));
        render();
    }

    // ---- listed detection ----------------------------------------------------------------
    // The sell form is a full page POST. The submit event leaves a timestamp in sessionStorage (no
    // card data); the page that comes back shows a success alert and the new own row (stockRow<id>).

    document.addEventListener('submit', (e) => {
        if (e.target.id === 'ListProductForm' && state.active) sessionStorage.setItem(SUBMIT_KEY, String(Date.now()));
    }, true);

    function markDone(key, articleId) {
        state.done[key] = { articleId: articleId || null, at: Date.now() };
        saveDone();
        setStatus('Marked as listed.');
        render();
    }

    function checkListed() {
        const at = Number(sessionStorage.getItem(SUBMIT_KEY));
        if (!at || Date.now() - at > SUBMIT_WINDOW || !state.active?.filled) return;
        sessionStorage.removeItem(SUBMIT_KEY);
        if (!document.querySelector(SEL.successAlert)) {
            setStatus('Submit was not confirmed by Cardmarket. Check the page; use "done" if it was listed.');
            return;
        }
        const ids = [...document.querySelectorAll(SEL.ownRow)].map((e) => Number(e.id.replace('stockRow', ''))).filter(Boolean);
        markDone(state.active.key, ids.length ? String(Math.max(...ids)) : null);
        state.active = null;
        saveActive();
    }

    // Test hook: lets a script re-run the check without a real submit.
    document.addEventListener('cmlp-check', checkListed);

    // ---- panel ---------------------------------------------------------------------------

    function setStatus(text) {
        state.status = text;
        if (ui.status) ui.status.textContent = text;
    }

    function visibleRows() {
        const q = state.filter.trim().toLowerCase();
        return state.rows.filter((r) => {
            if (state.binder && state.binder !== '*' && r.binder !== state.binder) return false;
            if (state.hideDone && state.done[r.key]) return false;
            return !q || `${r.name} ${r.setCode} ${r.setName}`.toLowerCase().includes(q);
        });
    }

    function renderRow(r) {
        const info = state.scry[r.scryfallId];
        const done = state.done[r.key];
        const resolving = !(r.scryfallId in state.scry);
        const noId = !resolving && !info?.idProduct;

        const action = el('td', { className: 'cmlp-actions' });
        if (done) {
            action.append(el('span', { className: 'cmlp-done', textContent: 'listed' }));
            action.append(el('button', { type: 'button', textContent: 'undo', onclick: () => { delete state.done[r.key]; saveDone(); render(); } }));
        } else {
            action.append(el('button', {
                type: 'button', className: 'cmlp-fill', textContent: noId ? 'no ID' : 'Search',
                disabled: resolving || noId, onclick: () => search(r)
            }));
            action.append(el('button', { type: 'button', textContent: 'done', title: 'Mark as listed', onclick: () => markDone(r.key, null) }));
        }

        return el('tr', { className: (done ? 'cmlp-row-done ' : '') + (state.active?.key === r.key ? 'cmlp-row-active' : '') },
            el('td', { textContent: r.name }),
            el('td', { textContent: `${r.setCode} #${r.number}` }),
            el('td', { textContent: r.foil === 'normal' ? '' : r.foil }),
            el('td', { textContent: r.condition.replace('_', ' ') }),
            el('td', { textContent: r.language }),
            el('td', { textContent: r.qty }),
            action
        );
    }

    function render() {
        if (!ui.list) return;
        const rows = visibleRows();
        const names = binders();
        const files = Object.keys(state.files);
        ui.file.hidden = files.length < 2;
        ui.file.replaceChildren(...files.map((id) => el('option', { value: id, textContent: state.files[id].label, selected: id === state.activeFile })));
        ui.binder.hidden = names.length < 2;
        ui.binder.replaceChildren(...[...names, '*'].map((n) => el('option', { value: n, textContent: n === '*' ? 'All binders' : n, selected: n === state.binder })));
        const doneCount = state.rows.filter((r) => state.done[r.key]).length;
        ui.count.textContent = state.rows.length
            ? `${state.files[state.activeFile].label}: ${doneCount}/${state.rows.length} listed, ${rows.length} shown`
            : 'No CSV loaded';
        ui.list.replaceChildren(...rows.map(renderRow));
        ui.table.hidden = !rows.length;
        ui.body.hidden = state.collapsed;
        ui.toggle.textContent = state.collapsed ? '▸' : '▾';
        ui.toggle.title = state.collapsed ? 'Expand' : 'Collapse';
    }

    function buildPanel() {
        const file = el('input', { type: 'file', accept: '.csv', hidden: true });
        file.addEventListener('change', () => { if (file.files[0]) importCsv(file.files[0]); file.value = ''; });

        ui.status = el('span', { className: 'cmlp-status', textContent: state.status });
        ui.count = el('span', { className: 'cmlp-count' });
        ui.list = el('tbody');
        ui.table = el('table', { className: 'cmlp-table' },
            el('thead', {}, el('tr', {}, ...['Card', 'Set', 'Foil', 'Condition', 'Lang', 'Qty', ''].map((t) => el('th', { textContent: t })))),
            ui.list
        );

        const filter = el('input', { type: 'search', placeholder: 'Filter name or set', className: 'cmlp-filter' });
        filter.addEventListener('input', () => { state.filter = filter.value; render(); });
        ui.file = el('select', { title: 'CSV file', hidden: true });
        ui.file.addEventListener('change', () => { selectFile(ui.file.value); render(); });
        ui.binder = el('select', { title: 'Binder / list to show', hidden: true });
        ui.binder.addEventListener('change', () => {
            state.binder = ui.binder.value;
            state.files[state.activeFile].binder = state.binder;
            saveFiles();
            render();
        });
        const hide = el('input', { type: 'checkbox' });
        hide.addEventListener('change', () => { state.hideDone = hide.checked; render(); });

        ui.toggle = el('button', { type: 'button', className: 'cmlp-toggle', onclick: () => {
            state.collapsed = !state.collapsed;
            ext.storage.local.set({ collapsed: state.collapsed });
            render();
        } });

        ui.body = el('div', { className: 'cmlp-body' },
            el('div', { className: 'cmlp-head' },
                el('button', { type: 'button', textContent: 'Load ManaBox CSV', onclick: () => file.click() }),
                el('button', { type: 'button', textContent: 'Remove CSV', onclick: removeCsv }),
                el('button', { type: 'button', textContent: 'Settings', onclick: () => ext.runtime.sendMessage({ type: 'openOptions' }) }),
                file
            ),
            el('div', { className: 'cmlp-bar' }, ui.file, filter, ui.binder, el('label', {}, hide, ' hide listed')),
            ui.table
        );

        const panel = el('div', { id: 'cmlp-panel' },
            el('div', { className: 'cmlp-title' }, ui.toggle, el('strong', { textContent: 'Listing Assistant' }), ui.count),
            ui.status,
            ui.body
        );

        const mount = document.querySelector(SEL.mount);
        if (mount) mount.prepend(panel);
        else document.body.prepend(panel);
    }

    ext.storage.onChanged.addListener((changes) => {
        if (changes.settings) state.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    });

    (async function init() {
        await loadState();
        buildPanel();
        render();
        if (state.rows.length) {
            setStatus('Ready. Click "Search" on a card.');
            resolveScryfall();
        } else {
            setStatus('Load your ManaBox CSV to start.');
        }
        checkListed();
        resumeFill();
    })();
})();
