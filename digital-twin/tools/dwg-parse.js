// AC1015 (R2000) DWG 实体解析器 —— 提取 LINE / LWPOLYLINE / TEXT
// 参考 libredwg 格式实现；仅用于读取建筑平面图的墙线/文字
// 用法: node dwg-parse.js <file.dwg> [out.json]
//
// 关键格式结论（经本文件实测+CRC 校验）：
//  - 对象记录: [MS: 大小(字节)][BS: 类型码][RL: 句柄流位偏移][H: 自身句柄]...
//  - 对象 CRC: CRC16(0xC0C1) 覆盖 [start, start+ms+2)，存于 start+ms+2
//  - 本文件对象使用 R13-R2000 固定类型码（LINE=19, LWPOLYLINE=77, TEXT=1），
//    而非类号（类号仅用于 ≥500 的自定义类）
const fs = require('fs');
const path = require('path');

// ---------- CRC16 (poly 0xA001, 与 libredwg bit_calc_CRC 一致) ----------
const CRC_T = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xA001 : c >>> 1;
  CRC_T[i] = c;
}
function crc16(seed, buf, start, len) {
  let dx = seed & 0xFFFF;
  for (let i = 0; i < len; i++) dx = (dx >> 8) ^ CRC_T[(dx ^ buf[start + i]) & 0xFF];
  return dx & 0xFFFF;
}

// ---------- 位读取器（MSB 优先，位置可跨字节） ----------
class BR {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
    this.bit = 0;
  }
  b() {
    const r = (this.buf[this.pos] & (0x80 >> this.bit)) >> (7 - this.bit);
    if (++this.bit >= 8) { this.bit = 0; this.pos++; }
    return r;
  }
  bb() { return (this.b() << 1) | this.b(); }
  rc() {
    const byte = this.buf[this.pos];
    if (this.bit === 0) { this.pos++; return byte; }
    const next = this.buf[this.pos + 1];
    this.pos++;
    return ((byte << this.bit) | (next >> (8 - this.bit))) & 0xFF;
  }
  rs() { return this.rc() | (this.rc() << 8); }
  rsBE() { return (this.rc() << 8) | this.rc(); }
  rl() { return (this.rs() | (this.rs() << 16)) >>> 0; }
  rd() {
    const b = new Uint8Array(8);
    for (let i = 0; i < 8; i++) b[i] = this.rc();
    return new Float64Array(b.buffer, 0, 1)[0];
  }
  ms() {
    const w1 = this.rs();
    if (!(w1 & 0x8000)) return w1;
    const w0 = this.rs();
    return ((w1 & 0x7FFF) | (w0 << 15)) >>> 0;
  }
  umc() {
    let value = 0, shift = 0;
    while (true) {
      const b = this.rc();
      value |= (b & 0x7F) << shift;
      if (!(b & 0x80)) return value >>> 0;
      shift += 7;
    }
  }
  mc() {
    let value = 0, shift = 0;
    while (true) {
      const b = this.rc();
      if (!(b & 0x80)) {
        if (b & 0x40) value = -(value | ((b & 0x3F) << shift));
        else value |= b << shift;
        return value | 0;
      }
      value |= (b & 0x7F) << shift;
      shift += 7;
    }
  }
  bs() {
    const code = this.bb();
    if (code === 0) return this.rs();
    if (code === 1) return this.rc();
    if (code === 2) return 0;
    return 256;
  }
  bl() {
    const code = this.bb();
    if (code === 0) return this.rl();
    if (code === 1) return this.rc();
    if (code === 2) return 0;
    return 256;
  }
  bd() {
    const code = this.bb();
    if (code === 0) return this.rd();
    if (code === 1) return 1.0;
    if (code === 2) return 0.0;
    return 0.0;
  }
  dd(def) {
    const code = this.bb();
    if (code === 0) return def;
    if (code === 3) return this.rd();
    if (code === 2) {
      // 部分字节覆盖：保留默认值的高2字节(6,7)，低6字节按序 4,5,0,1,2,3 覆盖
      const b = new Uint8Array(8);
      new Float64Array(b.buffer)[0] = def;
      b[4] = this.rc(); b[5] = this.rc();
      b[0] = this.rc(); b[1] = this.rc(); b[2] = this.rc(); b[3] = this.rc();
      return new Float64Array(b.buffer)[0];
    }
    return def; // code 1: default+1（libredwg 按 default 处理）
  }
  bd1() {
    const code = this.bb();
    if (code === 0) return 1.0;
    if (code === 3) return this.rd();
    return 1.0;
  }
  bt() { return this.b() ? 0.0 : this.bd(); }
  bt0() { return this.b() ? 0.0 : this.bd(); }
  be() {
    if (this.b()) return [0, 0, 1];
    return [this.bd(), this.bd(), this.bd()];
  }
  h() {
    const cb = this.rc();
    const size = cb & 0x0F, code = (cb >> 4) & 0x0F;
    let value = 0;
    for (let i = 0; i < size; i++) value = (value << 8) | this.rc();
    return { code, size, value };
  }
  tv() {
    const len = this.bs(); // R13+ 字符串长度为 BS 编码
    if (len > 65535) return Buffer.alloc(0);
    const bytes = Buffer.from(this.buf.slice(this.pos, this.pos + len));
    this.pos += len;
    return bytes;
  }
}

// ---------- 解析主流程 ----------
function parseDwg(file) {
  const buf = fs.readFileSync(file);
  const magic = buf.slice(0, 6).toString('ascii');
  if (magic !== 'AC1015') throw new Error('仅支持 AC1015 (R2000): ' + magic);

  // 头部 + 段表
  const sections = [];
  let p = 0x19;
  for (let j = 0; j < 6; j++) {
    const num = buf[p], addr = buf.readUInt32LE(p + 1), size = buf.readUInt32LE(p + 5);
    p += 9;
    sections.push({ num, addr, size: addr + size <= buf.length ? size : 0 });
  }
  const S = (num) => sections.find((s) => s.num === num) || { addr: 0, size: 0 };

  // ---- Handles 段（对象映射） ----
  const objects = [];
  {
    const start = S(2).addr;
    const end = start + S(2).size;
    const br = new BR(buf, start);
    let lastOffset = 0;
    let guard = 0;
    while (br.pos < end - 4 && guard++ < 100000 && objects.length < 500000) {
      const pageStart = br.pos;
      const pageSize = br.rsBE();
      if (pageSize > 2040 || pageSize < 4 || br.pos + pageSize > end) break;
      const pageEnd = pageStart + pageSize;
      while (br.pos < pageEnd) {
        const old = br.pos;
        br.umc(); // handleoff
        const off = br.mc();
        if (br.pos === old) break;
        lastOffset += off;
        if (lastOffset < 0x80 || lastOffset > buf.length) {
          objects.pop();
          br.pos = pageEnd; // 无效偏移=映射结束标记，终止本页
          break;
        }
        objects.push(lastOffset);
      }
      if (br.bit) { br.bit = 0; br.pos++; }
      br.rsBE(); // 页CRC
    }
  }

  // ---- 解码实体 ----
  const GBK = new TextDecoder('gbk');
  const result = { lines: [], texts: [], lwpolylines: [], vertices: [], arcs: [], stats: { ok: 0, badCrc: 0, skipped: 0, types: {} } };
  const TYPE_LINE = 19, TYPE_LWPOLYLINE = 77, TYPE_TEXT = 1;

  for (const addr of objects) {
    if (addr < 0x80 || addr + 8 > buf.length) { result.stats.skipped++; continue; }
    const ms = buf.readUInt16LE(addr); // 大小：字节
    if (ms < 6 || ms > 2000000 || addr + ms + 4 > buf.length) { result.stats.skipped++; continue; }
    // CRC 校验（覆盖 MS 字段）
    if (crc16(0xC0C1, buf, addr, ms + 2) !== buf.readUInt16LE(addr + ms + 2)) {
      result.stats.badCrc++;
      continue;
    }
    const br = new BR(buf, addr + 2);
    let type;
    try { type = br.bs(); } catch { result.stats.skipped++; continue; }
    result.stats.types[type] = (result.stats.types[type] || 0) + 1;
    try {
      if (type === TYPE_LINE) {
        const l = decodeLine(br);
        if (process.env.DEBUG_LINE && result.lines.length < 5) {
          console.log('LINE@' + addr + ' ms=' + ms, JSON.stringify(l));
        }
        if (l && isSanePt(l.x1, l.y1) && isSanePt(l.x2, l.y2)) result.lines.push(l);
      } else if (type === TYPE_LWPOLYLINE) {
        const pl = decodeLwPolyline(br);
        if (pl && pl.points.length > 1 && pl.points.every((q) => isSanePt(q[0], q[1]))) result.lwpolylines.push(pl);
      } else if (type === TYPE_TEXT) {
        const t = decodeText(br, GBK);
        if (t) result.texts.push(t);
      } else if (type === 10) {
        // VERTEX_3D（天正墙体常以 3D 顶点序列存储）
        const v = decodeVertex3D(br);
        if (v) result.vertices.push(v);
      } else if (type === 17) {
        // ARC（圆心/半径，门扇弧线）
        const a = decodeArc(br);
        if (a) result.arcs.push(a);
      } else if (type === 15 || type === 16) {
        // POLYLINE_2D/3D 头（顶点由 VERTEX 实体承载，这里跳过）
        result.stats.skipped++; continue;
      } else { result.stats.skipped++; continue; }
      result.stats.ok++;
    } catch (e) {
      result.stats.skipped++;
    }
  }
  return result;
}

function isSanePt(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e7 && Math.abs(y) < 1e7;
}

// 公共实体数据（数据流）
function readCommonEntityData(br) {
  const preview = br.b();
  if (preview) {
    const ps = br.rl();
    if (ps > 0 && ps < 100000) { br.pos += ps; br.bit = 0; }
  }
  const entmode = br.bb();
  const numReactors = br.bl();
  const nolinks = br.b();
  const color = br.bs();
  br.bd1(); // ltype_scale
  const ltypeFlags = br.bb();
  const plotstyleFlags = br.bb();
  const invisible = br.bs();
  const linewt = br.rc();
  return { entmode, numReactors, nolinks, color, ltypeFlags, plotstyleFlags, invisible, linewt };
}

function decodeEntityHead(br) {
  br.rl(); // bitsize（句柄流偏移，坐标解析不需要）
  br.h(); // 自身句柄
  const eed = br.bs(); // EED
  if (eed > 0 && eed < 100000) { br.h(); br.pos += eed; br.bit = 0; }
  return readCommonEntityData(br);
}

function decodeLine(br) {
  decodeEntityHead(br);
  const zz = br.b();
  const x1 = br.rd();
  const x2 = br.dd(x1);
  const y1 = br.rd();
  const y2 = br.dd(y1);
  let z1 = 0, z2 = 0;
  if (!zz) { z1 = br.rd(); z2 = br.dd(z1); }
  br.bt0(); // thickness
  br.be(); // extrusion
  return { x1, y1, z1, x2, y2, z2 };
}

function decodeVertex3D(br) {
  decodeEntityHead(br);
  const flag = br.b();
  const x = br.bd(), y = br.bd(), z = br.bd();
  if (!isSanePt(x, y)) return null;
  return { flag, x, y, z };
}

function decodeArc(br) {
  decodeEntityHead(br);
  const x = br.bd(), y = br.bd(), z = br.bd();
  const radius = br.bd();
  const startAngle = br.bd();
  const endAngle = br.bd();
  br.bt0(); // thickness
  br.be(); // extrusion
  if (!isSanePt(x, y)) return null;
  return { x, y, z, radius, startAngle, endAngle };
}

function decodeLwPolyline(br) {
  decodeEntityHead(br);
  const flag = br.bs();
  if (flag & 4) br.bd();
  if (flag & 8) br.bd();
  if (flag & 2) br.bd();
  if (flag & 1) br.be();
  const numPoints = br.bl();
  if (numPoints > 20000) return null;
  let numBulges = 0, numWidths = 0;
  if (flag & 16) numBulges = br.bl();
  if (flag & 32) numWidths = br.bl();
  const pts = [];
  let px = br.rd(), py = br.rd();
  pts.push([px, py]);
  for (let i = 1; i < numPoints; i++) {
    px = br.dd(px);
    py = br.dd(py);
    pts.push([px, py]);
  }
  for (let i = 0; i < numBulges; i++) br.bd();
  for (let i = 0; i < numWidths; i++) { br.bd(); br.bd(); }
  return { flag, points: pts };
}

function decodeText(br, GBK) {
  decodeEntityHead(br);
  const dataflags = br.rc();
  if (!(dataflags & 1)) br.rd(); // elevation
  const x = br.rd(), y = br.rd(); // ins_pt
  if (!(dataflags & 2)) { br.dd(x); br.dd(y); } // alignment_pt
  br.be(); // extrusion
  br.bt(); // thickness
  if (!(dataflags & 4)) br.rd(); // oblique
  if (!(dataflags & 8)) br.rd(); // rotation
  br.rd(); // height
  if (!(dataflags & 0x10)) br.rd(); // width_factor
  const tv = br.tv();
  if (!(dataflags & 0x20)) br.bs();
  if (!(dataflags & 0x40)) br.bs();
  if (!(dataflags & 0x80)) br.bs();
  let text = '';
  try { text = GBK.decode(tv).replace(/\0+$/, ''); } catch { text = tv.toString('latin1'); }
  text = text.replace(/[^\u4e00-\u9fff\u3000-\u303fA-Za-z0-9%%. ++\-\-\/\/\(\)（）:：]/g, '').trim();
  if (!text) return null;
  return { x, y, text };
}

// ---------- CLI ----------
const file = process.argv[2];
if (!file) { console.log('用法: node dwg-parse.js <file.dwg> [out.json]'); process.exit(1); }
const res = parseDwg(file);
console.log('stats:', JSON.stringify(res.stats));
console.log('lines:', res.lines.length, 'lwpolylines:', res.lwpolylines.length, 'texts:', res.texts.length);
const out = process.argv[3] || file.replace(/\.dwg$/i, '.json');
fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log('→', out);
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const l of res.lines) {
  minX = Math.min(minX, l.x1, l.x2); maxX = Math.max(maxX, l.x1, l.x2);
  minY = Math.min(minY, l.y1, l.y2); maxY = Math.max(maxY, l.y1, l.y2);
}
for (const pl of res.lwpolylines) for (const [x, y] of pl.points) {
  minX = Math.min(minX, x); maxX = Math.max(maxX, x);
  minY = Math.min(minY, y); maxY = Math.max(maxY, y);
}
console.log('range X:', minX.toFixed(1), '..', maxX.toFixed(1), ' Y:', minY.toFixed(1), '..', maxY.toFixed(1));
if (res.texts.length) {
  console.log('texts sample:', res.texts.slice(0, 25).map((t) => `(${t.x.toFixed(0)},${t.y.toFixed(0)})${t.text}`).join(' | '));
}
