/*
 * jjzip.js - just enough ZIP for the toolkit page.
 *
 *   jjUnzip(bytes)       -> Promise<[{name, data}]>   stored and deflated
 *                           entries (deflate through the browser's
 *                           DecompressionStream); no ZIP64, no encryption
 *   jjZip([{name, data}]) -> Uint8Array               stored entries
 *
 * Used for loading a zipped JJ1 install (JAZZ.ZIP and the like) and for
 * handing the changed game files back as one download.
 */
'use strict';

const JJ_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function jjCrc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++)
        c = JJ_CRC[(c ^ data[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

async function jjInflateRaw(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function jjUnzip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--)
        if (dv.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    if (eocd < 0)
        throw new Error('not a ZIP file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
        if (dv.getUint32(p, true) !== 0x02014b50)
            throw new Error('damaged ZIP directory');
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const local = dv.getUint32(p + 42, true);
        const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith('/'))
            continue;
        if (dv.getUint32(local, true) !== 0x04034b50)
            throw new Error('damaged ZIP entry: ' + name);
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        const raw = bytes.subarray(start, start + csize);
        if (method === 0)
            out.push({ name, data: raw.slice() });
        else if (method === 8)
            out.push({ name, data: await jjInflateRaw(raw) });
        else
            throw new Error('unsupported ZIP compression (' + method + ') for ' + name);
    }
    return out;
}

function jjZip(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
        const name = enc.encode(e.name), crc = jjCrc32(e.data);
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true);
        h.setUint16(4, 20, true);
        h.setUint16(10, dosTime, true);
        h.setUint16(12, dosDate, true);
        h.setUint32(14, crc, true);
        h.setUint32(18, e.data.length, true);
        h.setUint32(22, e.data.length, true);
        h.setUint16(26, name.length, true);
        const c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true);
        c.setUint16(4, 20, true);
        c.setUint16(6, 20, true);
        c.setUint16(12, dosTime, true);
        c.setUint16(14, dosDate, true);
        c.setUint32(16, crc, true);
        c.setUint32(20, e.data.length, true);
        c.setUint32(24, e.data.length, true);
        c.setUint16(28, name.length, true);
        c.setUint32(42, offset, true);
        parts.push(new Uint8Array(h.buffer), name, e.data);
        central.push(new Uint8Array(c.buffer), name);
        offset += 30 + name.length + e.data.length;
    }
    const cdSize = central.reduce((s, b) => s + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
    let o = 0;
    for (const b of all) {
        out.set(b, o);
        o += b.length;
    }
    return out;
}

if (typeof module !== 'undefined')
    module.exports = { jjUnzip, jjZip, jjCrc32 };
