// Print session: status handshake, tape check, chunked job write and completion wait.
// Transport agnostic (D-03): it only needs write(chunk), read(timeoutMs), drain() and chunkSize. No DOM, no device API.
(function (root) {
    const PTouch = root.PTouch || require('./ptouch.js');   // page: script global; Node tests: module
    const STATUS_TIMEOUT_MS = 5000;
    const STATUS_ATTEMPTS = 3;
    const SILENCE_BASE_MS = 30000;     // printing is silent; the limit grows with the label length
    const SILENCE_PER_LINE_MS = 15;
    const TAIL_TIMEOUT_MS = 2000;
    const NO_ANSWER = 'The printer did not answer. Check that it is on and that no other app is connected, then try again.';

    class PrinterError extends Error {
        constructor(code, message, raw = '') {
            super(message);
            this.name = 'PrinterError';
            this.code = code;
            this.raw = raw;
        }
    }

    function fromTransport(e) {
        if (e instanceof PrinterError) return e;
        if (e && e.code === 'timeout') return new PrinterError('timeout', NO_ANSWER);
        const message = (e && e.message) || String(e);
        if (e && e.code === 'lost') return new PrinterError('lost', `Connection lost: ${message}`);
        return new PrinterError((e && e.code) || 'open', message);
    }

    function createSession(transport) {
        let buffer = new Uint8Array(0);

        async function send(bytes) {
            try {
                await transport.write(bytes);
            } catch (e) {
                throw fromTransport(e);
            }
        }

        async function nextStatus(timeoutMs) {
            for (;;) {
                const { frame, rest } = PTouch.takeFrame(buffer);
                buffer = rest;
                if (frame) return PTouch.parseStatus(frame);
                try {
                    buffer = PTouch.concat(buffer, await transport.read(timeoutMs));
                } catch (e) {
                    throw fromTransport(e);
                }
            }
        }

        function failure(status) {
            const d = PTouch.describeStatus(status);
            return new PrinterError(d.code, d.text, PTouch.formatRaw(status.raw));
        }

        async function readStatus() {
            transport.drain();
            buffer = new Uint8Array(0);
            const request = PTouch.concat(PTouch.invalidate(), PTouch.init(), PTouch.statusRequest());
            for (let attempt = 1; ; attempt++) {
                await send(request);
                try {
                    for (;;) {
                        const status = await nextStatus(STATUS_TIMEOUT_MS);
                        if (status.statusType === 0 || status.statusType === 2 || status.statusType === 4) return status;   // other types are notifications
                    }
                } catch (e) {
                    if (e.code !== 'timeout' || attempt >= STATUS_ATTEMPTS) throw e;
                }
            }
        }

        // One single-label job. Nothing is sent after the first job byte until the completion frame, and a job is never resent.
        async function print(bitmap, { cut = true } = {}) {
            const status = await readStatus();
            if (!PTouch.describeStatus(status).ok) throw failure(status);
            if (status.widthMm !== PTouch.TAPE_MM) throw new PrinterError('tape-mismatch', PTouch.tapeMismatchText(status), PTouch.formatRaw(status.raw));

            const job = PTouch.buildJob(bitmap, { cut });
            for (let at = 0; at < job.length; at += transport.chunkSize) await send(job.subarray(at, at + transport.chunkSize));

            for (;;) {
                const frame = await nextStatus(SILENCE_BASE_MS + SILENCE_PER_LINE_MS * bitmap.width);
                if (!PTouch.describeStatus(frame).ok) throw failure(frame);
                if (frame.statusType === 1) break;   // 5 and 6 are notifications and phase changes
            }
            // The job is printed; the trailing phase change is optional and a failure here must not mark the label failed
            await nextStatus(TAIL_TIMEOUT_MS).catch(() => {});
        }

        return { readStatus, print };
    }

    const api = { PrinterError, createSession, STATUS_TIMEOUT_MS, STATUS_ATTEMPTS, SILENCE_BASE_MS, SILENCE_PER_LINE_MS, TAIL_TIMEOUT_MS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Printer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
