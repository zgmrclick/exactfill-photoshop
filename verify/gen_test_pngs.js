/* Генерує тестові PNG НАШИМ png.js — заодно перевірка deflate проти декодера Photoshop. */
const fs = require('fs');
const path = require('path');
const { encodePng, setPngResolution, buildRectMaskPng, readPngSize } = require('../png.js');

const OUT = process.argv[2] || '.';
fs.mkdirSync(OUT, { recursive: true });

/** Контрастна рамка 50 px — ловить обрізання канвою на око й у пікселях. */
function makeRgb(w, h) {
    const px = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 3;
            const edge = x < 50 || y < 50 || x >= w - 50 || y >= h - 50;
            px[o] = edge ? 255 : 40;
            px[o + 1] = edge ? 0 : 90;
            px[o + 2] = edge ? 0 : 200;
        }
    }
    return px;
}

const report = [];
function emit(name, bytes) {
    const p = path.join(OUT, name);
    fs.writeFileSync(p, bytes);
    const s = readPngSize(bytes);
    report.push(`${name}\t${s.w}x${s.h}\t${bytes.length} B`);
    return p;
}

const base1024 = encodePng(makeRgb(1024, 1024), 1024, 1024, 3);
emit('vt_1024_nophys.png', base1024);
emit('vt_1024_p300.png', setPngResolution(base1024, 300));
emit('vt_1024_p72.png', setPngResolution(base1024, 72));

// непропорційний — для перевірки cover-режиму геометрії
const base1000x600 = encodePng(makeRgb(1000, 600), 1000, 600, 3);
emit('vt_1000x600_p300.png', setPngResolution(base1000x600, 300));

// маска Grey+Alpha (colorType 4) — чи читає Photoshop наш deflate у цьому форматі
emit('vt_mask_1024.png', buildRectMaskPng(1024, 1024, { left: 200, top: 150, right: 800, bottom: 650 }));

console.log(report.join('\n'));
