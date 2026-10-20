// Label page: #sets= fragment -> one card per set -> canvas -> 1-bit bitmap -> PNG download.
const CODE_SAMPLE_FONT = '700 44px Cinzel';

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

async function renderBitmap(set) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await Promise.all([
        set.glyph === null ? null : document.fonts.load('100px Keyrune', String.fromCodePoint(set.glyph)),
        document.fonts.load(CODE_SAMPLE_FONT, 'Aa')
    ]);
    const { width, height, ops } = LabelCore.layoutLabel(
        { code: set.code, glyph: set.glyph, showIcon: true, showCode: true }, measureWith(ctx));
    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    drawOps(ctx, ops);
    return LabelCore.toBitmap(ctx.getImageData(0, 0, width, height).data, width, height);
}

// Shows the exact bitmap that gets encoded (ink black, tape white)
function paintBitmap(canvas, bitmap) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const image = new ImageData(bitmap.width, bitmap.height);
    for (let y = 0; y < bitmap.height; y++) {
        for (let x = 0; x < bitmap.width; x++) {
            const ink = bitmap.bits[y * bitmap.stride + (x >> 3)] & (0x80 >> (x & 7));
            const i = (y * bitmap.width + x) * 4;
            image.data[i] = image.data[i + 1] = image.data[i + 2] = ink ? 0 : 255;
            image.data[i + 3] = 255;
        }
    }
    canvas.getContext('2d').putImageData(image, 0, 0);
}

function downloadBytes(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function addCard(container, code) {
    const set = { code, glyph: LabelCore.glyphFor(KEYRUNE, code) };
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.code = code;
    const title = document.createElement('h2');
    title.textContent = code.toUpperCase();
    const canvas = document.createElement('canvas');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'download';
    button.textContent = 'Download PNG';
    card.append(title, canvas, button);
    container.append(card);

    const bitmap = await renderBitmap(set);
    paintBitmap(canvas, bitmap);
    button.addEventListener('click', () => {
        downloadBytes(LabelCore.encodePng1bit(bitmap, LabelCore.DPI), `${code}.png`, 'image/png');
    });
    card.dataset.ready = '1';
}

(async function init() {
    const empty = document.getElementById('empty');
    const error = document.getElementById('error');
    try {
        const codes = LabelCore.parseFragment(location.hash);
        empty.hidden = codes.length > 0;
        for (const code of codes) await addCard(document.getElementById('cards'), code);
    } catch (e) {
        error.textContent = String(e.message || e);
        error.hidden = false;
    }
})();
