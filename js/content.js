(function () {
    // The authenticator page gets no panel and no keep-alive fetch.
    if (/\/TwoFactorAuthentication(\/|$)/.test(location.pathname)) return;

    const ext = globalThis.browser ?? globalThis.chrome;
    const { CONDITION_ID, LANGUAGE_ID, DEFAULT_SETTINGS, buildRows, parsePrice, formatPrice, computePrice, buildSearchUrl } = CMLP;

    // Every Cardmarket DOM assumption lives here.
    const SEL = {
        mount: 'main.container',
        form: 'form#ListProductForm',
        filterForm: 'form#FilterForm',
        pageTitle: '.page-title-container',
        header: 'header#header',
        sellTab: 'a[href="#tabContent-sell"]',
        sellPane: '#tabContent-sell',
        offerRow: '.article-row[id^="articleRow"]',
        offerPrice: '.price-container',
        ownRow: '[id^="stockRow"]',
        successAlert: '.systemMessage.alert-success',
        logout: 'a[href*="Logout"]'
    };
    const SUBMIT_KEY = 'cmlp.submitAt';
    const SNAP_KEY = 'cmlp.formSnap';
    const SNAP_FIELDS = ['amount', 'idLanguage', 'idCondition', 'comments', 'price', 'isFoil', 'isSigned', 'isAltered', 'saveSettings'];
    const SUBMIT_WINDOW = 60 * 1000;
    const FILL_MAX_AGE = 10 * 60 * 1000;
    const BATCH = 75;
    const KEEP_ALIVE_EVERY = 30 * 60 * 1000;

    const state = {
        files: {}, rows: [], activeFile: '', scry: {}, done: {}, active: null,
        settings: { ...DEFAULT_SETTINGS },
        filter: '', binder: '', sort: null, hideDone: false, collapsed: false, status: ''
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
        const s = await ext.storage.local.get(['csvs', 'activeFile', 'scryfall', 'done', 'settings', 'collapsed', 'hideDone', 'active']);
        state.files = s.csvs || {};
        // CSVs stored before the scan-order column have no seq; CSV position is the best we can rebuild.
        for (const f of Object.values(state.files)) f.rows.forEach((r, i) => { r.seq ??= i + 1; });
        state.scry = s.scryfall || {};
        state.done = s.done || {};
        state.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
        state.collapsed = !!s.collapsed;
        state.hideDone = !!s.hideDone;
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
        if (missing.length) setStatus('');
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

    // The Sell tab is not necessarily the one Cardmarket opens by default.
    function showSellTab() {
        const pane = document.querySelector(SEL.sellPane);
        if (pane && !pane.offsetParent) document.querySelector(SEL.sellTab)?.click();
    }

    // Puts the card title at the top, below the fixed header, so the sell form and the offers are in view.
    // 'instant' because the page may use smooth scrolling.
    function scrollToTitle() {
        const title = document.querySelector(SEL.pageTitle);
        if (!title) return;
        const top = title.getBoundingClientRect().top + scrollY - (document.querySelector(SEL.header)?.offsetHeight || 0);
        window.scrollTo({ top, behavior: 'instant' });
    }

    // Price from the offers shown for the applied filter, formatted for the form; null if none.
    async function autoPrice() {
        await waitFor(() => document.querySelector(SEL.offerRow), 5000);
        const offers = [...document.querySelectorAll(SEL.offerRow)]
            .map((r) => r.querySelector(SEL.offerPrice)?.textContent || '');
        const price = computePrice(state.settings, offers);
        return price == null ? null : formatPrice(price);
    }

    // Runs on the product page after "Search": fills the Sell tab form from the CSV row.
    async function resumeFill() {
        const a = state.active;
        if (!a || a.filled || Date.now() - a.at > FILL_MAX_AGE) return;
        const form = document.querySelector(SEL.form);
        if (!form || form.elements.idAddProduct?.value !== a.idProduct) return;
        const row = allRows().find((r) => r.key === a.key);
        if (!row) return;

        showSellTab();

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
        const price = await autoPrice();
        if (state.settings.priceSource !== 'none') {
            if (price == null) notes.push('no offers match the filter, enter the price by hand');
            else setField(f.price, price);
        }

        state.active.filled = true;
        state.active.autoPrice = price;
        await saveActive();
        f.price.focus({ preventScroll: true });
        scrollToTitle();
        // The filled row is highlighted in the list; the status line only reports problems.
        setStatus(notes.length ? `${row.name}: ${notes.join('; ')}.` : '');
        render();
        // Scroll only the list, not the page: the price field has just been focused.
        const active = ui.list.querySelector('.cmlp-row-active');
        if (active) ui.scroll.scrollTop = active.offsetTop - ui.scroll.clientHeight / 2;
    }

    // Click a price in the offers table: copy it into the sell form's price field.
    document.addEventListener('click', (e) => {
        const cell = e.target.closest?.(`${SEL.offerRow} ${SEL.offerPrice}`);
        const price = document.querySelector(SEL.form)?.elements.price;
        const n = cell && price ? parsePrice(cell.textContent) : null;
        if (n == null) return;
        setField(price, formatPrice(n));
        price.focus({ preventScroll: true });
        // A picked price is the user's choice: do not replace it with a recomputed one after a filter reload.
        if (state.active) { state.active.autoPrice = null; saveActive(); }
    });

    // The filter button is a full page POST and the sell form would come back empty: keep its values
    // in sessionStorage across that reload (tab scoped, short lived) and put them back afterwards.
    document.addEventListener('submit', (e) => {
        if (e.target.id !== 'FilterForm') return;
        const f = document.querySelector(SEL.form)?.elements;
        if (!f || !state.active) return;
        const values = {};
        for (const n of SNAP_FIELDS) if (f[n]) values[n] = f[n].type === 'checkbox' ? f[n].checked : f[n].value;
        sessionStorage.setItem(SNAP_KEY, JSON.stringify({ at: Date.now(), idProduct: f.idAddProduct?.value, values }));
    }, true);

    async function restoreForm() {
        const snap = JSON.parse(sessionStorage.getItem(SNAP_KEY) || 'null');
        sessionStorage.removeItem(SNAP_KEY);
        const form = document.querySelector(SEL.form);
        if (!snap || Date.now() - snap.at > SUBMIT_WINDOW || form?.elements.idAddProduct?.value !== snap.idProduct) return;
        showSellTab();
        scrollToTitle();
        for (const [name, v] of Object.entries(snap.values)) {
            const field = form.elements[name];
            if (!field || (field.tagName === 'SELECT' && ![...field.options].some((o) => o.value === v))) continue;
            if (typeof v === 'boolean') setChecked(field, v); else setField(field, v);
        }
        // The auto-filled price depends on the filter: recompute it, keep a price the user entered.
        if (state.active?.autoPrice && snap.values.price === state.active.autoPrice) {
            const price = await autoPrice();
            if (price) {
                setField(form.elements.price, price);
                state.active.autoPrice = price;
                saveActive();
            }
        }
    }

    // Changing the condition or language in the sell form applies it to the filter (and reloads the offers).
    // isTrusted skips the change events the plugin dispatches itself while filling.
    document.addEventListener('change', (e) => {
        const name = e.target.name;
        if (!e.isTrusted || !state.active || e.target.form?.id !== 'ListProductForm') return;
        if (name !== 'idCondition' && name !== 'idLanguage') return;
        const filter = document.querySelector(SEL.filterForm)?.elements;
        if (!filter) return;
        if (name === 'idCondition') {
            if (!filter.minCondition) return;
            filter.minCondition.value = e.target.value;
        } else {
            // The filter has one checkbox per language: only the chosen one stays checked.
            const boxes = [...document.querySelector(SEL.filterForm).querySelectorAll('input[name^="language["]')];
            if (!boxes.some((b) => b.name === `language[${e.target.value}]`)) return;
            for (const b of boxes) b.checked = b.name === `language[${e.target.value}]`;
        }
        filter.apply.click();
    });

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

    // Sortable columns; the trailing actions column has no sort key.
    const COLUMNS = [
        // Scanned order: ManaBox's Added timestamp, CSV position as tie-break.
        { title: '#', sortKey: (r) => `${r.added || ''}|${String(r.seq ?? 0).padStart(6, '0')}` },
        { title: 'Card', sortKey: (r) => r.name },
        { title: 'Set', sortKey: (r) => `${r.setCode} ${r.number}` },
        { title: 'Foil', sortKey: (r) => r.foil },
        { title: 'Condition', sortKey: (r) => CONDITION_ID[r.condition] || 99 },
        { title: 'Lang', sortKey: (r) => r.language },
        { title: 'Qty', sortKey: (r) => r.qty },
        { title: '' }
    ];

    const compare = (a, b) => typeof a === 'number' ? a - b : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

    function visibleRows() {
        const q = state.filter.trim().toLowerCase();
        const rows = state.rows.filter((r) => {
            if (state.binder && state.binder !== '*' && r.binder !== state.binder) return false;
            if (state.hideDone && state.done[r.key]) return false;
            return !q || `${r.name} ${r.setCode} ${r.setName}`.toLowerCase().includes(q);
        });
        if (state.sort) {
            const { sortKey } = COLUMNS[state.sort.col];
            rows.sort((a, b) => state.sort.dir * compare(sortKey(a), sortKey(b)));
        }
        return rows;
    }

    // Click cycles ascending, descending, off (CSV order).
    function sortBy(col) {
        const s = state.sort;
        state.sort = s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null;
        render();
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
            el('td', { className: 'cmlp-seq', textContent: r.seq ?? '' }),
            el('td', { textContent: r.name }),
            el('td', { textContent: `${r.setCode} #${r.number}` }),
            el('td', { textContent: r.foil === 'normal' ? '' : r.foil }),
            el('td', { textContent: r.condition.replace('_', ' ') }),
            el('td', { textContent: r.language.toUpperCase() }),
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
        ui.heads.forEach((th, i) => {
            th.textContent = COLUMNS[i].title;
            th.dataset.sort = state.sort?.col === i ? (state.sort.dir === 1 ? 'asc' : 'desc') : '';
        });
        ui.list.replaceChildren(...rows.map(renderRow));
        ui.scroll.hidden = !rows.length;
        ui.body.hidden = state.collapsed;
        ui.toggle.classList.toggle('is-collapsed', state.collapsed);
        ui.toggle.title = state.collapsed ? 'Expand' : 'Collapse';
    }

    function buildPanel() {
        const file = el('input', { type: 'file', accept: '.csv', hidden: true });
        file.addEventListener('change', () => { if (file.files[0]) importCsv(file.files[0]); file.value = ''; });

        ui.status = el('span', { className: 'cmlp-status', textContent: state.status });
        ui.count = el('span', { className: 'cmlp-count' });
        ui.list = el('tbody');
        ui.table = el('table', { className: 'cmlp-table' },
            el('thead', {}, el('tr', {}, ...(ui.heads = COLUMNS.map((c, i) => el('th', c.sortKey ? { className: 'is-sortable', title: 'Sort', onclick: () => sortBy(i) } : {}))))),
            ui.list
        );
        ui.scroll = el('div', { className: 'cmlp-scroll' }, ui.table);

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
        const hide = el('input', { type: 'checkbox', checked: state.hideDone });
        hide.addEventListener('change', () => { state.hideDone = hide.checked; ext.storage.local.set({ hideDone: state.hideDone }); render(); });

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
            ui.scroll
        );

        const panel = el('div', { id: 'cmlp-panel' },
            el('div', { className: 'cmlp-title' }, el('strong', { textContent: 'Listing Assistant' }), ui.count, ui.toggle),
            ui.status,
            ui.body,
            el('div', { className: 'cmlp-drop', textContent: 'Drop your ManaBox CSV files here' })
        );

        // Drop CSV files anywhere on the panel; dragenter/leave fire per child, so count depth.
        // During a drag only the MIME type is readable (not the name): accept the types an OS reports for a .csv, check the name on drop.
        const CSV_TYPES = ['text/csv', 'text/x-csv', 'text/plain', 'text/comma-separated-values', 'application/csv', 'application/x-csv', 'application/vnd.ms-excel'];
        const isFileDrag = (e) => e.dataTransfer?.types?.includes('Files');
        const wantsFiles = (e) => [...e.dataTransfer.items].some((i) => CSV_TYPES.includes(i.type));
        let depth = 0;
        panel.addEventListener('dragenter', (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            depth++;
            panel.classList.toggle('is-dragover', wantsFiles(e));
        });
        panel.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; panel.classList.remove('is-dragover'); } });
        panel.addEventListener('dragover', (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault(); // always cancel, otherwise the browser would open the dropped file
            e.dataTransfer.dropEffect = wantsFiles(e) ? 'copy' : 'none';
        });
        panel.addEventListener('drop', async (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            depth = 0;
            panel.classList.remove('is-dragover');
            const csvs = [...e.dataTransfer.files].filter((f) => /\.csv$/i.test(f.name));
            if (!csvs.length) { setStatus('Drop a .csv file.'); return; }
            for (const f of csvs) await importCsv(f);
        });

        // No main.container means no real Cardmarket page (e.g. the Cloudflare challenge): show no panel.
        document.querySelector(SEL.mount)?.prepend(panel);
    }

    // Cardmarket drops the login cookie after 1 h without a request; a plain page fetch renews it.
    // Only runs while logged in, which also keeps it off the login and authenticator pages.
    let keepAliveTimer = null;
    function syncKeepAlive() {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
        if (!state.settings.keepAlive) return;
        keepAliveTimer = setInterval(() => {
            if (!document.querySelector(SEL.logout)) return;
            fetch(`/${location.pathname.split('/')[1]}/Magic`, { credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
        }, KEEP_ALIVE_EVERY);
    }

    ext.storage.onChanged.addListener((changes) => {
        if (changes.settings) {
            state.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
            syncKeepAlive();
        }
    });

    (async function init() {
        await loadState();
        syncKeepAlive();
        buildPanel();
        render();
        if (document.querySelector(SEL.form)) document.documentElement.classList.add('cmlp-price-pick');
        if (state.rows.length) {
            resolveScryfall();
        } else {
            setStatus('Load your ManaBox CSV to start.');
        }
        checkListed();
        await resumeFill();
        await restoreForm();
    })();
})();
