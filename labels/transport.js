// Device transports behind one contract (D-03): open(), write(chunk), read(timeoutMs), drain(), close().
// Every rejection is an Error whose code is one of timeout, lost, busy, permission, open.
// The API object (the USB object of the page) is injected so Node tests can pass fakes.
(function (root) {
    const USB_VENDOR = 0x04f9;
    const USB_PRODUCT = 0x20af;   // PT-P710BT
    const USB_IFACE = 0;
    const USB_OUT_EP = 2;
    const USB_IN_EP = 1;
    const USB_PACKET = 64;
    const USB_CHUNK = 1024;       // bytes per transferOut
    const QUEUE_CAP = 4096;       // receive queue limit, the oldest bytes are dropped

    const coded = (code, message) => Object.assign(new Error(message), { code });

    // Bytes pushed by a read pump, read by the print session. One reader at a time.
    class ByteQueue {
        constructor(timers) {
            this.timers = timers || { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
            this.buf = new Uint8Array(0);
            this.waiters = [];
            this.error = null;
        }

        push(chunk) {
            const joined = new Uint8Array(this.buf.length + chunk.length);
            joined.set(this.buf);
            joined.set(chunk, this.buf.length);
            this.buf = joined.length > QUEUE_CAP ? joined.slice(joined.length - QUEUE_CAP) : joined;
            const waiter = this.waiters.shift();
            if (waiter) {
                this.timers.clearTimeout(waiter.timer);
                waiter.resolve(this.take());
            }
        }

        fail(err) {
            this.error = err;
            for (const w of this.waiters.splice(0)) {
                this.timers.clearTimeout(w.timer);
                w.reject(err);
            }
        }

        take() {
            const out = this.buf;
            this.buf = new Uint8Array(0);
            return out;
        }

        // Resolves all queued bytes as one Uint8Array; timeoutMs 0 polls.
        read(timeoutMs) {
            if (this.buf.length) return Promise.resolve(this.take());
            if (this.error) return Promise.reject(this.error);
            if (timeoutMs === 0) return Promise.reject(coded('timeout', 'No data received'));
            return new Promise((resolve, reject) => {
                const waiter = { resolve, reject, timer: null };
                waiter.timer = this.timers.setTimeout(() => {
                    this.waiters.splice(this.waiters.indexOf(waiter), 1);
                    reject(coded('timeout', 'No data received'));
                }, timeoutMs);
                this.waiters.push(waiter);
            });
        }

        drain() {
            this.buf = new Uint8Array(0);
        }
    }

    function openError(e) {
        if (e && e.name === 'NetworkError') {
            return coded('busy', 'Another program is using the printer. Quit P-touch Editor and other Brother software, then connect again.');
        }
        if (e && e.name === 'SecurityError') return coded('permission', 'Access to the printer was not allowed. Connect again and allow access.');
        return coded('open', (e && e.message) || 'Could not open the USB connection.');
    }

    class UsbTransport {
        // The chooser needs a user gesture: call this first in the click handler, with no await before it (D-06 amendment).
        static request(usb) {
            const pending = usb.requestDevice({ filters: [{ vendorId: USB_VENDOR, productId: USB_PRODUCT }] });
            return pending.then((device) => new UsbTransport(usb, device));
        }

        // The first device the page was already granted, or null. No prompt.
        static async granted(usb) {
            const devices = await usb.getDevices();
            return devices.find((d) => d.vendorId === USB_VENDOR && d.productId === USB_PRODUCT) || null;
        }

        constructor(usb, device, timers) {
            this.usb = usb;
            this.device = device;
            this.queue = new ByteQueue(timers);
            this.chunkSize = USB_CHUNK;
            this.onLost = null;
            this.closing = false;
            this.lostError = null;
            this.listener = null;
        }

        async open() {
            const { device } = this;
            try {
                await device.open();
                if (device.configuration === null) await device.selectConfiguration(1);
                await device.claimInterface(USB_IFACE);
            } catch (e) {
                await device.close().catch(() => {});
                throw openError(e);
            }
            this.listener = (event) => {
                if (event.device === this.device) this.lose('The printer was unplugged or switched off.');
            };
            this.usb.addEventListener('disconnect', this.listener);
            this.pump();
        }

        // Marks the link dead once: fails pending and later reads, tells the page, returns the error.
        lose(message) {
            if (this.lostError || this.closing) return this.lostError || coded('lost', message);
            this.lostError = coded('lost', message);
            this.queue.fail(this.lostError);
            if (this.onLost) this.onLost(this.lostError);
            return this.lostError;
        }

        // One persistent transferIn loop; an abandoned pending read would swallow the next status frame.
        async pump() {
            try {
                while (!this.closing) {
                    const result = await this.device.transferIn(USB_IN_EP, USB_PACKET);
                    if (this.closing) return;
                    if (result.status !== 'ok') throw new Error(`USB read ended with status ${result.status}`);
                    const { data } = result;
                    if (data && data.byteLength) this.queue.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
                }
            } catch (e) {
                this.lose(e.message || 'USB read failed');
            }
        }

        // No short timeout: the printer can block a write for the whole print.
        async write(chunk) {
            let result;
            try {
                result = await this.device.transferOut(USB_OUT_EP, chunk);
            } catch (e) {
                throw this.lose(e.message || 'USB write failed');
            }
            if (result.status !== 'ok') throw this.lose(`USB write ended with status ${result.status}`);
        }

        read(timeoutMs) {
            return this.queue.read(timeoutMs);
        }

        drain() {
            this.queue.drain();
        }

        async close() {
            if (this.closing) return;
            this.closing = true;
            if (this.listener) this.usb.removeEventListener('disconnect', this.listener);
            await this.device.releaseInterface(USB_IFACE).catch(() => {});
            await this.device.close().catch(() => {});
        }
    }

    const api = { ByteQueue, UsbTransport, USB_VENDOR, USB_PRODUCT, USB_IFACE, USB_OUT_EP, USB_IN_EP, USB_PACKET, USB_CHUNK, QUEUE_CAP };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Transport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
