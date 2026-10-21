// Print controls of the label page: Connect USB, the printer status line and one Print button per card.
// Status and error text reaches the DOM through textContent only.
const PrintUI = (function () {
    let $, renderFresh;
    let transport = null;
    let session = null;
    let connected = false;
    let busy = false;
    const recs = new WeakMap();   // Print button -> card record

    const setStatus = (text) => { $('printerStatus').textContent = text; };

    function refresh() {
        for (const button of document.querySelectorAll('button[data-action="print"]')) {
            const rec = recs.get(button);
            button.disabled = !(connected && !busy && rec && rec.result && !rec.result.layout.empty);
        }
    }

    async function disconnect() {
        const old = transport;
        transport = null;
        session = null;
        connected = false;
        if (old) await old.close();
    }

    async function connect(next) {
        await disconnect();   // the same printer cannot be claimed twice
        transport = next;
        next.onLost = (err) => {
            if (transport !== next) return;
            transport = null;
            session = null;
            connected = false;
            setStatus(`Connection lost: ${err.message}`);
            refresh();
        };
        try {
            await next.open();
            session = Printer.createSession(next);
            const status = await session.readStatus();
            connected = true;
            const d = PTouch.describeStatus(status);
            setStatus(`USB printer connected. ${d.ok ? `${status.widthMm} mm tape loaded.` : d.text}`);
        } catch (e) {
            await disconnect();
            throw e;
        }
        refresh();
    }

    async function printCard(rec, stateEl) {
        if (busy || !session) return;
        busy = true;
        refresh();
        stateEl.textContent = 'Printing';
        try {
            const { bitmap, layout } = await renderFresh(rec);   // fresh render, never the cached rec.result.bitmap
            if (layout.empty) {
                stateEl.textContent = '';
                return;
            }
            await session.print(bitmap, { cut: true });
            stateEl.textContent = 'Printed';
        } catch (e) {
            stateEl.textContent = `Failed: ${e.message || e}`;
        } finally {
            busy = false;
            refresh();
        }
    }

    function init(deps) {
        ({ $, renderFresh } = deps);
        setStatus('Not connected. Connect a printer to print.');
        const button = $('connectUsb');
        if (!navigator.usb) {
            button.disabled = true;
            button.title = 'USB needs a Chromium based browser';
            return;
        }
        button.addEventListener('click', async () => {
            const pending = Transport.UsbTransport.request(navigator.usb);
            try {
                await connect(await pending);
            } catch (e) {
                if (e && e.name === 'NotFoundError') return;   // chooser cancelled or no device: stay as we were
                setStatus(e.message || String(e));
            }
        });
    }

    function cardControls(rec) {
        const print = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Print', disabled: true });
        print.dataset.action = 'print';
        const state = Object.assign(document.createElement('span'), { className: 'print-state' });
        print.addEventListener('click', () => printCard(rec, state));
        recs.set(print, rec);
        return [print, state];
    }

    return { init, cardControls, refresh };
})();
