import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../labels/transport.js');

// Fake timers: nothing fires until the test calls fire()
function fakeTimers() {
    const pending = new Map();
    let next = 1;
    return {
        setTimeout: (fn, ms) => { pending.set(next, { fn, ms }); return next++; },
        clearTimeout: (id) => { pending.delete(id); },
        count: () => pending.size,
        fire: () => { for (const [id, t] of [...pending]) { pending.delete(id); t.fn(); } }
    };
}

const rejection = async (promise) => {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    assert.fail('expected a rejection');
};
const tick = () => new Promise((r) => setImmediate(r));

test('ByteQueue: push then read returns the bytes as one Uint8Array and empties the queue', async () => {
    const q = new T.ByteQueue(fakeTimers());
    q.push(Uint8Array.of(1, 2));
    q.push(Uint8Array.of(3));
    const out = await q.read(1000);
    assert.ok(out instanceof Uint8Array);
    assert.deepEqual(Array.from(out), [1, 2, 3]);
    assert.equal((await rejection(q.read(0))).code, 'timeout');
});

test('ByteQueue: a read waits and resolves on a later push, and clears its timer', async () => {
    const timers = fakeTimers();
    const q = new T.ByteQueue(timers);
    const pending = q.read(5000);
    assert.equal(timers.count(), 1);
    q.push(Uint8Array.of(9));
    assert.deepEqual(Array.from(await pending), [9]);
    assert.equal(timers.count(), 0);
});

test('ByteQueue: a read times out with code timeout', async () => {
    const timers = fakeTimers();
    const q = new T.ByteQueue(timers);
    const pending = rejection(q.read(5000));
    timers.fire();
    assert.equal((await pending).code, 'timeout');
    q.push(Uint8Array.of(1));
    assert.deepEqual(Array.from(await q.read(0)), [1], 'a late push is kept for the next read');
});

test('ByteQueue: read(0) on an empty queue rejects at once', async () => {
    const timers = fakeTimers();
    const q = new T.ByteQueue(timers);
    assert.equal((await rejection(q.read(0))).code, 'timeout');
    assert.equal(timers.count(), 0);
});

test('ByteQueue: fail rejects the pending read and every later read with that error', async () => {
    const q = new T.ByteQueue(fakeTimers());
    const err = Object.assign(new Error('gone'), { code: 'lost' });
    const pending = rejection(q.read(5000));
    q.fail(err);
    assert.equal(await pending, err);
    assert.equal(await rejection(q.read(5000)), err);
    assert.equal(await rejection(q.read(0)), err);
});

test('[T-02-02] ByteQueue keeps only the newest 4096 bytes', async () => {
    assert.equal(T.QUEUE_CAP, 4096);
    const q = new T.ByteQueue(fakeTimers());
    q.push(new Uint8Array(3000).fill(1));
    q.push(new Uint8Array(2000).fill(2));
    const out = await q.read(0);
    assert.equal(out.length, 4096);
    assert.equal(out[0], 1);
    assert.equal(out[out.length - 1], 2);
    assert.equal(out.filter((b) => b === 2).length, 2000);
});

test('ByteQueue: drain empties the queue', async () => {
    const q = new T.ByteQueue(fakeTimers());
    q.push(Uint8Array.of(1, 2, 3));
    q.drain();
    assert.equal((await rejection(q.read(0))).code, 'timeout');
});

// ---- UsbTransport against a fake device and a fake usb object -----------------------------------

function fakeDevice(over = {}) {
    const d = {
        vendorId: 0x04f9, productId: 0x20af, configuration: null,
        calls: [], outs: [], ins: [], inWaiters: [],
        async open() { d.calls.push('open'); },
        async selectConfiguration(n) { d.calls.push(`selectConfiguration:${n}`); },
        async claimInterface(n) { d.calls.push(`claimInterface:${n}`); },
        async releaseInterface(n) { d.calls.push(`releaseInterface:${n}`); },
        async close() { d.calls.push('close'); },
        async transferOut(ep, data) { d.outs.push([ep, Array.from(data)]); return { status: 'ok', bytesWritten: data.length }; },
        // queued results first, then a pending promise that close() can reject
        transferIn(ep, len) {
            d.calls.push(`transferIn:${ep}:${len}`);
            if (d.ins.length) return Promise.resolve(d.ins.shift());
            return new Promise((resolve, reject) => d.inWaiters.push({ resolve, reject }));
        },
        ...over
    };
    return d;
}

function fakeUsb(devices = []) {
    const usb = new EventTarget();
    usb.requested = [];
    usb.requestDevice = async (options) => { usb.requested.push(options); return devices[0]; };
    usb.getDevices = async () => devices;
    return usb;
}

const view = (...bytes) => ({ status: 'ok', data: new DataView(Uint8Array.from(bytes).buffer) });
const disconnect = (usb, device) => usb.dispatchEvent(Object.assign(new Event('disconnect'), { device }));

test('UsbTransport.request passes exactly the Brother PT-P710BT filter and resolves a transport', async () => {
    const device = fakeDevice();
    const usb = fakeUsb([device]);
    const pending = T.UsbTransport.request(usb);
    assert.equal(usb.requested.length, 1, 'requestDevice is called synchronously');
    assert.deepEqual(usb.requested[0], { filters: [{ vendorId: 0x04f9, productId: 0x20af }] });
    const transport = await pending;
    assert.ok(transport instanceof T.UsbTransport);
    assert.equal(transport.device, device);
});

test('UsbTransport.request passes a cancelled chooser through untouched', async () => {
    const usb = fakeUsb();
    const cancel = Object.assign(new Error('none selected'), { name: 'NotFoundError' });
    usb.requestDevice = () => Promise.reject(cancel);
    assert.equal(await rejection(T.UsbTransport.request(usb)), cancel);
});

test('UsbTransport.granted returns the matching device, or null for an empty list or other vendors', async () => {
    const other = fakeDevice({ vendorId: 0x1234 });
    const wrongProduct = fakeDevice({ productId: 0x1 });
    const match = fakeDevice();
    assert.equal(await T.UsbTransport.granted(fakeUsb([])), null);
    assert.equal(await T.UsbTransport.granted(fakeUsb([other, wrongProduct])), null);
    assert.equal(await T.UsbTransport.granted(fakeUsb([other, match])), match);
});

test('UsbTransport.open selects configuration 1 only when none is set, then claims interface 0', async () => {
    const fresh = fakeDevice();
    await new T.UsbTransport(fakeUsb(), fresh, fakeTimers()).open();
    assert.deepEqual(fresh.calls.slice(0, 3), ['open', 'selectConfiguration:1', 'claimInterface:0']);

    const configured = fakeDevice({ configuration: {} });
    await new T.UsbTransport(fakeUsb(), configured, fakeTimers()).open();
    assert.deepEqual(configured.calls.slice(0, 2), ['open', 'claimInterface:0']);
});

test('UsbTransport: the caller writes slices, each goes out as one transferOut on endpoint 2', async () => {
    const device = fakeDevice();
    const t = new T.UsbTransport(fakeUsb(), device, fakeTimers());
    await t.open();
    assert.equal(t.chunkSize, 1024);
    const job = Uint8Array.from({ length: 2500 }, (_, i) => i & 255);
    for (let at = 0; at < job.length; at += t.chunkSize) await t.write(job.subarray(at, at + t.chunkSize));
    assert.deepEqual(device.outs.map(([ep, bytes]) => [ep, bytes.length]), [[2, 1024], [2, 1024], [2, 452]]);
    assert.deepEqual(device.outs.flatMap(([, bytes]) => bytes), Array.from(job));
});

test('UsbTransport: the pump feeds transferIn(1, 64) results into read', async () => {
    const device = fakeDevice();
    device.ins.push(view(0x80, 0x20, 0x42), view(7, 8));
    const t = new T.UsbTransport(fakeUsb(), device, fakeTimers());
    await t.open();
    await tick();
    assert.deepEqual(Array.from(await t.read(0)), [0x80, 0x20, 0x42, 7, 8]);
    assert.ok(device.calls.includes('transferIn:1:64'));
    device.inWaiters[0].resolve(view(1));
    await tick();
    assert.deepEqual(Array.from(await t.read(0)), [1]);
    t.drain();
    assert.equal((await rejection(t.read(0))).code, 'timeout');
    await t.close();
});

test('UsbTransport: a disconnect of this device fails the queue with lost and calls onLost once; another device does nothing', async () => {
    const device = fakeDevice();
    const usb = fakeUsb([device]);
    const t = new T.UsbTransport(usb, device, fakeTimers());
    const lost = [];
    t.onLost = (e) => lost.push(e);
    await t.open();

    disconnect(usb, fakeDevice());
    assert.equal(lost.length, 0);
    assert.equal((await rejection(t.read(0))).code, 'timeout', 'queue still healthy');

    disconnect(usb, device);
    disconnect(usb, device);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].code, 'lost');
    assert.equal((await rejection(t.read(1000))).code, 'lost');
});

test('UsbTransport: a failing transferIn or transferOut means lost', async () => {
    const device = fakeDevice();
    const t = new T.UsbTransport(fakeUsb(), device, fakeTimers());
    const lost = [];
    t.onLost = (e) => lost.push(e);
    await t.open();
    device.inWaiters[0].resolve({ status: 'stall' });
    await tick();
    assert.equal((await rejection(t.read(0))).code, 'lost');
    assert.equal(lost.length, 1);

    const broken = fakeDevice({ transferOut: async () => { throw new Error('unplugged'); } });
    const w = new T.UsbTransport(fakeUsb(), broken, fakeTimers());
    await w.open();
    assert.equal((await rejection(w.write(Uint8Array.of(1)))).code, 'lost');
    const notOk = new T.UsbTransport(fakeUsb(), fakeDevice({ transferOut: async () => ({ status: 'stall' }) }), fakeTimers());
    await notOk.open();
    assert.equal((await rejection(notOk.write(Uint8Array.of(1)))).code, 'lost');
});

test('UsbTransport.open: NetworkError is busy and names P-touch Editor, SecurityError is permission, others are open', async () => {
    const attempt = async (name) => {
        const device = fakeDevice({ claimInterface: async () => { throw Object.assign(new Error('x'), { name }); } });
        const e = await rejection(new T.UsbTransport(fakeUsb(), device, fakeTimers()).open());
        assert.ok(device.calls.includes('close'), 'a half-open device is closed again');
        return e;
    };
    const busy = await attempt('NetworkError');
    assert.equal(busy.code, 'busy');
    assert.match(busy.message, /Quit P-touch Editor/);
    assert.equal((await attempt('SecurityError')).code, 'permission');
    assert.equal((await attempt('SomethingElse')).code, 'open');
});

test('UsbTransport.close releases interface 0 and closes once; a pending transferIn failing afterwards does not fail the queue', async () => {
    const device = fakeDevice();
    const usb = fakeUsb([device]);
    const t = new T.UsbTransport(usb, device, fakeTimers());
    const lost = [];
    t.onLost = (e) => lost.push(e);
    await t.open();
    await t.close();
    await t.close();
    assert.equal(device.calls.filter((c) => c === 'releaseInterface:0').length, 1);
    assert.equal(device.calls.filter((c) => c === 'close').length, 1);

    device.inWaiters[0].reject(new Error('transfer aborted'));
    await tick();
    assert.equal(lost.length, 0);
    assert.equal((await rejection(t.read(0))).code, 'timeout', 'queue not failed');
    disconnect(usb, device);
    assert.equal(lost.length, 0, 'the listener is removed');
});

test('close swallows errors from releaseInterface and close', async () => {
    const device = fakeDevice({ releaseInterface: async () => { throw new Error('r'); }, close: async () => { throw new Error('c'); } });
    const t = new T.UsbTransport(fakeUsb(), device, fakeTimers());
    await t.open().catch(() => {});
    const ok = new T.UsbTransport(fakeUsb(), fakeDevice({ releaseInterface: async () => { throw new Error('r'); } }), fakeTimers());
    await ok.open();
    await ok.close();
});
