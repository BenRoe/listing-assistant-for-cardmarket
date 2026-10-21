// Print controls of the label page: Connect USB, Refresh, Cut, Print all, the printer status lines and Print plus copies on every card.
// Bluetooth is deferred (D-17), so USB is the only connection. Status and error text reaches the DOM through textContent only.
// No timers and no polling (D-07): the status is read on connect, before every print and on Refresh.
const PrintUI = (function () {
    let $, renderFresh, records, settings, updateSettings;
    let phase = 'disconnected';   // disconnected | connecting | ready | printing
    let transport = null;
    let session = null;
    let knownDevice = null;       // a USB device the page was granted before, or null
    let usbReason = '';
    const parts = new WeakMap();  // card record -> { print, copies, state }

    const NOT_CONNECTED = 'Not connected. Connect a printer to print.';
    const label = 'USB';

    function setStatus(text, raw = '') {
        $('printerStatus').textContent = text;
        $('printerRaw').textContent = raw;
    }

    const setState = (rec, text) => { parts.get(rec).state.textContent = text; };
    const printable = (rec) => !!(rec.result && !rec.result.layout.empty);

    // D-09: the reason comes from feature detection, never from a browser name
    function featureReasons() {
        const usb = !('usb' in navigator) ? 'USB needs a Chromium based browser' : !window.isSecureContext ? 'needs a secure page' : '';
        return { usb };
    }

    function refresh() {
        const ready = phase === 'ready';
        const cards = records();
        for (const rec of cards) {
            const p = parts.get(rec);
            p.print.disabled = !(ready && printable(rec));
            p.print.title = ready ? '' : 'Connect a printer first';
            p.copies.disabled = phase === 'printing';
        }
        const idle = ready ? '' : 'Connect a printer first';
        $('printAll').disabled = !(ready && cards.some(printable));
        $('printAll').title = idle;
        $('refresh').disabled = !ready;
        $('refresh').title = idle;
        $('connectUsb').disabled = !!usbReason || phase === 'connecting' || phase === 'printing';
    }

    // The grant list changes after a close or a loss; an unplugged device is gone from it
    async function refreshKnown() {
        knownDevice = null;
        if (usbReason) return;
        try {
            knownDevice = await Transport.UsbTransport.granted(navigator.usb);
        } catch {
            knownDevice = null;   // no grant information: Connect asks again
        }
    }

    function dropTransport() {
        const old = transport;
        transport = null;
        session = null;
        if (old) old.close().catch(() => {});
    }

    // D-10: back to disconnected, printed counters and card states stay, no retry
    function handleLost(text, tail = '') {
        dropTransport();
        phase = 'disconnected';
        setStatus([text, tail, 'Press Connect to reconnect.'].filter(Boolean).join(' '));
        refresh();
        refreshKnown().then(refresh);
    }

    function showStatus(status) {
        const d = PTouch.describeStatus(status);
        const raw = PTouch.formatRaw(status.raw);
        if (!d.ok) return setStatus(d.text, raw);
        if (status.widthMm !== PTouch.TAPE_MM) return setStatus(`${label} printer connected. ${status.widthMm} mm tape loaded, but labels are made for ${PTouch.TAPE_MM} mm tape.`, raw);
        setStatus(`${label} printer ready. ${status.widthMm} mm tape loaded.`);
    }

    // `pending` is the transport promise made by the click handler's first statement. `silent` (load time) shows no error.
    async function connect(pending, { silent = false } = {}) {
        if (phase === 'connecting' || phase === 'printing') return;
        const before = phase;
        phase = 'connecting';
        refresh();
        let next;
        try {
            next = await pending;
        } catch (e) {
            phase = before;   // chooser cancelled or refused: stay as we were
            if (!silent && !(e && e.name === 'NotFoundError')) setStatus(e.message || String(e));
            refresh();
            return;
        }
        dropTransport();   // the same printer cannot be claimed twice
        transport = next;
        next.onLost = (err) => { if (transport === next) handleLost(Printer.lostText(err.message)); };
        try {
            await next.open();
            session = Printer.createSession(next);
            const status = await session.readStatus();
            if (transport !== next) return;   // lost while connecting
            phase = 'ready';
            updateSettings({ transport: 'usb' });
            showStatus(status);
        } catch (e) {
            if (transport === next) dropTransport();
            phase = 'disconnected';
            setStatus(silent ? NOT_CONNECTED : e.message || String(e));
            refreshKnown().then(refresh);
        }
        refresh();
    }

    const knownTransport = () => Promise.resolve(new Transport.UsbTransport(navigator.usb, knownDevice));

    async function refreshStatus() {
        if (phase !== 'ready') return;
        phase = 'connecting';   // blocks every other control while the status is read
        refresh();
        try {
            showStatus(await session.readStatus());
            phase = 'ready';
        } catch (e) {
            if (e.code === 'lost') return handleLost(e.message);
            phase = 'ready';
            setStatus(e.message || String(e), e.raw);
        }
        refresh();
    }

    // D-08, D-18: one single-label job per physical label; the first error stops the run and the counters say where to resume
    async function runJobs(recs, { reset }) {
        if (phase !== 'ready' || !session) return;
        phase = 'printing';
        if (reset) for (const rec of recs) rec.printed = 0;
        const skipped = new Set();
        const sum = (field) => recs.filter((r) => !skipped.has(r)).reduce((n, r) => n + (field === 'printed' ? Math.min(r.printed, r.copies) : r.copies), 0);
        for (const rec of recs) if (rec.printed < rec.copies) setState(rec, 'Queued');
        setStatus('');
        refresh();
        let current = null;
        try {
            for (const rec of recs) {
                if (rec.printed >= rec.copies) continue;
                current = rec;
                const { bitmap, layout } = await renderFresh(rec);   // fresh render, never the cached rec.result.bitmap
                if (layout.empty) {
                    skipped.add(rec);
                    setState(rec, '');
                    continue;
                }
                while (rec.printed < rec.copies) {
                    const k = rec.printed + 1;
                    setState(rec, rec.copies === 1 ? 'Printing' : `Printing ${k} of ${rec.copies}`);
                    await session.print(bitmap, { cut: settings().cut });
                    rec.printed = k;
                    setState(rec, rec.copies === 1 ? 'Printed' : `Printed ${k} of ${rec.copies}`);
                }
            }
            setStatus(`Printed ${sum('copies')} of ${sum('copies')}.`);
        } catch (e) {
            for (const rec of recs) if (rec.printed < rec.copies) setState(rec, rec === current ? 'Failed' : 'Queued');
            const progress = `${sum('printed')} of ${sum('copies')} printed.`;
            const text = (e && e.message) || String(e);
            if (e && e.code === 'lost') handleLost(text, progress);
            else setStatus(`${text} ${progress}`, (e && e.raw) || '');
        } finally {
            if (phase === 'printing') phase = 'ready';
            refresh();
        }
    }

    function printAll() {
        const list = records().filter(printable);
        if (!list.length) return;
        runJobs(list, { reset: list.every((rec) => rec.printed >= rec.copies) });   // a finished run starts again from zero
    }

    function init(deps) {
        ({ $, renderFresh, records, settings, updateSettings } = deps);
        setStatus(NOT_CONNECTED);
        usbReason = featureReasons().usb;
        $('usbReason').textContent = usbReason;
        $('connectUsb').addEventListener('click', () => {
            const pending = knownDevice ? knownTransport() : Transport.UsbTransport.request(navigator.usb);
            return connect(pending);
        });
        $('refresh').addEventListener('click', refreshStatus);
        $('printAll').addEventListener('click', printAll);
        $('optCut').addEventListener('change', (e) => { updateSettings({ cut: e.target.checked }); });
        refresh();
        // D-06: a device granted before connects without a click; any failure stays silent
        refreshKnown().then(() => {
            if (knownDevice && phase === 'disconnected') return connect(knownTransport(), { silent: true });
        }).then(refresh);
    }

    function cardControls(rec) {
        const print = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Print', disabled: true });
        print.dataset.action = 'print';
        const copies = Object.assign(document.createElement('input'), { type: 'number', className: 'copies', min: 1, max: 99, step: 1, value: rec.copies });
        copies.title = 'Copies';
        copies.setAttribute('aria-label', 'Copies');
        const state = Object.assign(document.createElement('span'), { className: 'print-state' });
        print.addEventListener('click', () => runJobs([rec], { reset: true }));
        copies.addEventListener('change', () => {
            rec.copies = LabelCore.normalizeCopies(Number(copies.value));
            copies.value = rec.copies;
            updateSettings({ copies: rec.copies });
        });
        parts.set(rec, { print, copies, state });
        const copiesLabel = document.createElement('label');
        copiesLabel.append('Copies ', copies);
        return [print, copiesLabel, state];
    }

    // foil or condition changed: the label is another one, so earlier prints no longer count
    function cardChanged(rec) {
        rec.printed = 0;
        setState(rec, '');
    }

    return { init, cardControls, cardChanged, refresh };
})();
