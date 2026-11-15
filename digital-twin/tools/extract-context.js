// 从杭州分块 shp 提取医院周边 3D 环境：水系 / 上塘高架 / 公园树木 / 地标
// 坐标与 data/city.js 完全一致：WGS84 -> 以 BASEMAP 中心为原点的地图米（x=东, z=南），
// 与卫星底图、周边建筑共用同一个 group 变换。
// 用法：node tools/extract-context.js [--radius=1600] [--src=/path/杭州 分块]
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const SRC = args.src || '/Users/ccchen/Downloads/杭州数据/杭州 分块';
const RADIUS = +(args.radius || 1500);
const LON = 120.16375, LAT = 30.28745;
const R = 6378137;
const mercX = (lon) => ((lon + 180) / 360) * 2 * Math.PI * R;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2 * 2 * Math.PI * R;
const X0 = mercX(LON), Y0 = mercY(LAT), COS = Math.cos((LAT * Math.PI) / 180);
const toMap = (lon, lat) => [
  +((mercX(lon) - X0) * COS).toFixed(2),
  +((mercY(lat) - Y0) * COS).toFixed(2),
];
const dist = (x, z) => Math.hypot(x, z);
const dec = new TextDecoder('gbk');

function readDbf(file) {
  const b = fs.readFileSync(file);
  const nrec = b.readUInt32LE(4), hlen = b.readUInt16LE(8), rlen = b.readUInt16LE(10);
  const fields = [];
  let p = 32;
  while (b[p] !== 0x0d) {
    fields.push({ name: b.slice(p, p + 11).toString('ascii').replace(/\0+$/, ''), off: p, len: b[p + 16] });
    p += 32;
  }
  const get = (i, name) => {
    const f = fields.find((x) => x.name === name);
    if (!f) return '';
    const q = hlen + i * rlen + 1 + f.off - 32;
    return dec.decode(b.slice(q, q + f.len)).trim();
  };
  return { nrec, get };
}

function readShp(file) {
  const b = fs.readFileSync(file);
  const shx = fs.readFileSync(file.replace(/\.shp$/i, '.shx'));
  const out = [];
  const n = (shx.length - 100) / 8;
  for (let i = 0; i < n; i++) {
    const off = shx.readInt32BE(100 + i * 8) * 2;
    const type = b.readInt32LE(off + 8);
    if (type !== 5 && type !== 3) continue;
    const bbox = [b.readDoubleLE(off + 12), b.readDoubleLE(off + 20), b.readDoubleLE(off + 28), b.readDoubleLE(off + 36)];
    const numParts = b.readInt32LE(off + 44);
    const numPoints = b.readInt32LE(off + 48);
    const partsOff = off + 52, pointsOff = partsOff + numParts * 4;
    const starts = [];
    for (let k = 0; k < numParts; k++) starts.push(b.readInt32LE(partsOff + k * 4));
    const parts = [];
    for (let k = 0; k < numParts; k++) {
      const s = starts[k], e = k + 1 < numParts ? starts[k + 1] : numPoints;
      const pts = [];
      for (let j = s; j < e; j++) {
        const lon = b.readDoubleLE(pointsOff + j * 16);
        const lat = b.readDoubleLE(pointsOff + j * 16 + 8);
        pts.push(toMap(lon, lat));
      }
      if (pts.length >= 2) parts.push(pts);
    }
    out.push({ i, type, bbox, parts });
  }
  return out;
}

function ringCentroid(ring) {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
}
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}
function inRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function nearestRingPoint(ring) {
  let best = 1e30, bp = ring[0];
  for (const p of ring) {
    const d = p[0] * p[0] + p[1] * p[1];
    if (d < best) { best = d; bp = p; }
  }
  return bp;
}
// 折线裁剪到半径 R 的圆内，返回连续段
function clipLineCircle(pts, R) {
  const pieces = [];
  let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const A = dx * dx + dz * dz;
    let t0 = 0, t1 = 1;
    if (A < 1e-12) {
      if (a[0] * a[0] + a[1] * a[1] > R * R) continue;
    } else {
      const B = 2 * (a[0] * dx + a[1] * dz);
      const C = a[0] * a[0] + a[1] * a[1] - R * R;
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      const r0 = (-B - sq) / (2 * A), r1 = (-B + sq) / (2 * A);
      t0 = Math.max(0, Math.min(r0, r1));
      t1 = Math.min(1, Math.max(r0, r1));
      if (t0 > t1) continue;
    }
    const p0 = [a[0] + dx * t0, a[1] + dz * t0];
    const p1 = [a[0] + dx * t1, a[1] + dz * t1];
    if (!cur || Math.hypot(cur[cur.length - 1][0] - p0[0], cur[cur.length - 1][1] - p0[1]) > 1.5) {
      if (cur) pieces.push(cur);
      cur = [p0];
    }
    cur.push(p1);
    if (t1 < 1) { pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  return pieces.filter((p) => p.length >= 2);
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 水系 ----------
const waterDbf = readDbf(path.join(SRC, '杭州 水系.dbf'));
const water = [];
for (const r of readShp(path.join(SRC, '杭州 水系.shp'))) {
  const name = waterDbf.get(r.i, 'Name') || '';
  const cx = (r.bbox[0] + r.bbox[2]) / 2, cy = (r.bbox[1] + r.bbox[3]) / 2;
  const [mx, mz] = toMap(cx, cy);
  if (dist(mx, mz) > RADIUS) continue;
  for (const part of r.parts) {
    if (part.length < 3) continue;
    const ring = part.slice();
    if (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length >= 3 && ringArea(ring) > 20) water.push({ name, ring });
  }
}

// ---------- 公园绿地 ----------
const greenDbf = readDbf(path.join(SRC, '杭州 绿地.dbf'));
const green = [];
const seen = new Map();
for (const r of readShp(path.join(SRC, '杭州 绿地.shp'))) {
  const name = greenDbf.get(r.i, 'Name') || '';
  if (!(name.includes('公园') || name === '古艮山门')) continue;
  if (name.includes('医院')) continue;
  const cx = (r.bbox[0] + r.bbox[2]) / 2, cy = (r.bbox[1] + r.bbox[3]) / 2;
  const [mx, mz] = toMap(cx, cy);
  if (dist(mx, mz) > RADIUS) continue;
  const ring = r.parts[0];
  if (!ring || ring.length < 3) continue;
  const area = ringArea(ring);
  if (area < 300) continue;
  const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...zs) - Math.min(...zs);
  if (bw > 400 || bh > 400) continue; // 排除细长/异常大的绿地
  const key = name + '|' + Math.round((Math.min(...xs) + Math.max(...xs)) / 2 / 20) + '|' + Math.round((Math.min(...zs) + Math.max(...zs)) / 2 / 20);
  const prev = seen.get(key);
  if (prev) { if (ring.length > prev.ring.length) prev.ring = ring; continue; }
  const ring2 = ring.slice();
  if (ring2[0][0] === ring2[ring2.length - 1][0] && ring2[0][1] === ring2[ring2.length - 1][1]) ring2.pop();
  const entry = { name, ring: ring2 };
  seen.set(key, entry);
  green.push(entry);
}

// ---------- 上塘高架 ----------
const roadDbf = readDbf(path.join(SRC, '杭州 城市快速路.dbf'));
const viaduct = [];
for (const r of readShp(path.join(SRC, '杭州 城市快速路.shp'))) {
  const name = roadDbf.get(r.i, 'Name') || '';
  if (!name.includes('上塘高架')) continue;
  const cx = (r.bbox[0] + r.bbox[2]) / 2, cy = (r.bbox[1] + r.bbox[3]) / 2;
  const [mx, mz] = toMap(cx, cy);
  if (dist(mx, mz) > RADIUS) continue;
  const parts = [];
  for (const p of r.parts) for (const c of clipLineCircle(p, RADIUS)) parts.push(c);
  if (parts.length) viaduct.push({ name, parts });
}

// ---------- 公园树 ----------
const rng = mulberry32(20260715);
const trees = [];
for (const g of green) {
  const xs = g.ring.map((p) => p[0]), zs = g.ring.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const spacing = 13;
  for (let x = x0 + 8; x <= x1 - 8; x += spacing) {
    for (let z = z0 + 8; z <= z1 - 8; z += spacing) {
      const px = x + (rng() * 2 - 1) * 5, pz = z + (rng() * 2 - 1) * 5;
      if (!inRing(px, pz, g.ring)) continue;
      trees.push([+px.toFixed(1), +pz.toFixed(1), +(0.85 + rng() * 0.45).toFixed(2)]);
      if (trees.length >= 600) break;
    }
    if (trees.length >= 600) break;
  }
  if (trees.length >= 600) break;
}

// ---------- 地标 ----------
const labels = [];
for (const w of water) {
  if (!w.name || (w.name !== '京杭运河' && w.name !== '上塘河')) continue;
  if (labels.some((l) => l.text === w.name)) continue;
  const c = nearestRingPoint(w.ring);
  labels.push({ text: w.name, x: +c[0].toFixed(1), z: +c[1].toFixed(1), kind: 'water' });
}
{
  let best = null;
  for (const v of viaduct) for (const p of v.parts) {
    let len = 0;
    for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (!best || len > best.len) best = { len, p };
  }
  if (best) {
    let bestD = 1e30, bp = null;
    for (const v of viaduct) for (const p of v.parts) for (const q of p) {
      const d = q[0] * q[0] + q[1] * q[1];
      if (d < bestD) { bestD = d; bp = q; }
    }
    if (bp) labels.push({ text: '上塘高架', x: +bp[0].toFixed(1), z: +bp[1].toFixed(1), kind: 'viaduct' });
  }
}
{
  const park = green.find((g) => g.name.includes('朝晖公园')) || green[0];
  if (park) {
    const c = ringCentroid(park.ring);
    labels.push({ text: park.name, x: +c[0].toFixed(1), z: +c[1].toFixed(1), kind: 'park' });
  }
}

const out = `// 医院周边 3D 环境（WGS84 -> BASEMAP 地图米，x=东 z=南）
// 由 tools/extract-context.js 生成：--radius=${RADIUS}
// 水系/绿地：杭州 水系.shp / 杭州 绿地.shp；高架：杭州 城市快速路.shp(Name=上塘高架)
export const CONTEXT = ${JSON.stringify({ radius: RADIUS, water, green, viaduct, trees, labels }, null, 0)};
`;
const target = path.resolve(__dirname, '../data/context.js');
fs.writeFileSync(target, out);
console.log('water', water.length, 'green', green.length, 'viaduct parts', viaduct.reduce((s, v) => s + v.parts.length, 0), 'trees', trees.length, 'labels', labels.length);
console.log('→', target, (fs.statSync(target).size / 1024).toFixed(1) + 'KB');
