// Print session: status handshake, tape check, chunked job write and completion wait.
// Transport agnostic (D-03): it only needs write(chunk), read(timeoutMs), drain() and chunkSize. No DOM, no device API.
(function (root) {
    const PTouch = root.PTouch || require('./ptouch.js');   // page: script global; Node tests: module
    const STATUS_TIMEOUT_MS = 5000;
    const STATUS_ATTEMPTS = 3;
    const SILENCE_BASE_MS = 30000;     // printing is silent; the limit grows with the label length
    const SILENCE_PER_LINE_MS = 15;
    const TAIL_TIMEOUT_MS = 2000;
    const NO_ANSWER_TEXT = 'The printer did not answer. Check that it is on and that no other app is connected, then try again.';

    // "Connection lost: <reason>. ..." from a reason with or without a trailing period
    const lostText = (reason) => `Connection lost: ${String(reason).replace(/\.$/, '')}. The printer may have switched itself off.`;

    class PrinterError extends Error {
        constructor(code, message, raw = '', status = null) {
            super(message);
            this.name = 'PrinterError';
            this.code = code;
            this.raw = raw;
            this.status = status;
        }
    }

    function fromTransport(e) {
        if (e instanceof PrinterError) return e;
        if (e && e.code === 'timeout') return new PrinterError('timeout', NO_ANSWER_TEXT);
        const message = (e && e.message) || String(e);
        if (e && e.code === 'lost') return new PrinterError('lost', lostText(message));
        return new PrinterError((e && e.code) || 'open', message);
    }

    function createSession(transport) {
        let buffer = new Uint8Array(0);

        // After any failure the receive buffer starts clean; the next readStatus resets the printer with the invalidate bytes
        const clearOnError = (fn) => async (...args) => {
            try {
                return await fn(...args);
            } catch (e) {
                buffer = new Uint8Array(0);
                throw e;
            }
        };

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

        const failure = (d, status) => new PrinterError(d.code, d.text, PTouch.formatRaw(status.raw), status);

        // The frames of a normal job (phase change, completed, phase change) pass; every error does not
        function checkDuringJob(status) {
            const d = PTouch.describeStatus(status, { duringJob: true });
            if (!d.ok) throw failure(d, status);
        }

        const readStatus = clearOnError(async () => {
            transport.drain();
            buffer = new Uint8Array(0);
            const request = PTouch.concat(PTouch.invalidate(), PTouch.init(), PTouch.statusRequest());
            let skipped = null;   // the latest notification or phase change frame, tells busy from silent
            for (let attempt = 1; ; attempt++) {
                await send(request);
                try {
                    for (;;) {
                        const status = await nextStatus(STATUS_TIMEOUT_MS);
                        if (status.statusType === 0 || status.statusType === 2 || status.statusType === 4) return status;   // other types are notifications
                        skipped = status;
                    }
                } catch (e) {
                    if (e.code !== 'timeout' || attempt >= STATUS_ATTEMPTS) {
                        if (e.code === 'timeout' && skipped && skipped.phaseType === 1) {
                            throw new PrinterError('busy', PTouch.SENTENCES.busy, PTouch.formatRaw(skipped.raw), skipped);
                        }
                        throw e;
                    }
                }
            }
        });

        // An error frame can arrive while the job is still being written (the printer starts printing early); look between slices.
        // Frames stay in the buffer: a short job can finish before the last write returns, and the completion wait must still see its frame.
        async function pollErrors() {
            for (;;) {
                try {
                    buffer = PTouch.concat(buffer, await transport.read(0));
                } catch (e) {
                    if (e && e.code === 'timeout') break;
                    throw fromTransport(e);
                }
            }
            for (let rest = buffer; ;) {
                const next = PTouch.takeFrame(rest);
                if (!next.frame) return;
                rest = next.rest;
                checkDuringJob(PTouch.parseStatus(next.frame));
            }
        }

        // One single-label job. Nothing is sent after the first job byte until the completion frame, and a job is never resent.
        const print = clearOnError(async (bitmap, { cut = true } = {}) => {
            const status = await readStatus();
            const verdict = PTouch.describeStatus(status);
            if (!verdict.ok) throw failure(verdict, status);
            if (status.widthMm !== PTouch.TAPE_MM) throw new PrinterError('tape-mismatch', PTouch.tapeMismatchText(status), PTouch.formatRaw(status.raw), status);

            const job = PTouch.buildJob(bitmap, { cut });
            buffer = new Uint8Array(0);
            for (let at = 0; at < job.length; at += transport.chunkSize) {
                await send(job.subarray(at, at + transport.chunkSize));
                await pollErrors();
            }

            for (;;) {
                const frame = await nextStatus(SILENCE_BASE_MS + SILENCE_PER_LINE_MS * bitmap.width);
                checkDuringJob(frame);
                if (frame.statusType === 1) break;   // 5 and 6 are notifications and phase changes
            }
            // The job is printed; the trailing phase change is optional and a failure here must not mark the label failed
            await nextStatus(TAIL_TIMEOUT_MS).catch(() => {});
        });

        return { readStatus, print };
    }

    const api = { PrinterError, createSession, lostText, NO_ANSWER_TEXT, STATUS_TIMEOUT_MS, STATUS_ATTEMPTS, SILENCE_BASE_MS, SILENCE_PER_LINE_MS, TAIL_TIMEOUT_MS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Printer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
