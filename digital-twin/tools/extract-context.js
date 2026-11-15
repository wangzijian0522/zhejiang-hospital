// 从杭州分块 shp 提取医院周边 3D 环境：水系 / 上塘高架 / 公园 / 行道树 / 桥 / 标注
// 坐标与 data/city.js 完全一致：WGS84 -> 以 BASEMAP 中心为原点的地图米（x=东, z=南），
// 与卫星底图、周边建筑共用同一个 group 变换。
// 用法：node tools/extract-context.js [--radius=1500] [--src=/path/杭州 分块]
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
  let p = 32, dataOff = 1; // 记录首字节为删除标记，字段数据从 +1 开始
  while (b[p] !== 0x0d) {
    const len = b[p + 16];
    fields.push({ name: b.slice(p, p + 11).toString('ascii').replace(/\0+$/, ''), off: dataOff, len });
    dataOff += len;
    p += 32;
  }
  const get = (i, name) => {
    const f = fields.find((x) => x.name === name);
    if (!f) return '';
    const q = hlen + i * rlen + f.off;
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
function ringBox(ring) {
  let x0 = 1e30, x1 = -1e30, z0 = 1e30, z1 = -1e30;
  for (const p of ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  return { ring, minX: x0, maxX: x1, minZ: z0, maxZ: z1 };
}
function inRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function inBoxes(x, z, boxes) {
  for (const b of boxes) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (inRing(x, z, b.ring)) return true;
  }
  return false;
}
function nearestRingPoint(ring) {
  let best = 1e30, bp = ring[0];
  for (const p of ring) {
    const d = p[0] * p[0] + p[1] * p[1];
    if (d < best) { best = d; bp = p; }
  }
  return bp;
}
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

const CAMPUS = { x0: -168, x1: 153, z0: -123, z1: 103 };

// 已有城市建筑，用于行道树避让
let CITY_BOXES = [];
try {
  const src = fs.readFileSync(path.resolve(__dirname, '../data/city.js'), 'utf8');
  const city = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
  CITY_BOXES = city.buildings.map((b) => {
    const ring = [];
    for (let i = 1; i < b.length; i += 2) ring.push([b[i], b[i + 1]]);
    return ring.length >= 3 ? ringBox(ring) : null;
  }).filter(Boolean);
} catch { CITY_BOXES = []; }

// ---------- 水系 ----------
const waterDbf = readDbf(path.join(SRC, '杭州 水系.dbf'));
const water = [];
for (const r of readShp(path.join(SRC, '杭州 水系.shp'))) {
  const name = waterDbf.get(r.i, 'Name') || '';
  const [mx, mz] = toMap((r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2);
  if (dist(mx, mz) > RADIUS) continue;
  for (const part of r.parts) {
    if (part.length < 3) continue;
    const ring = part.slice();
    if (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length >= 3 && ringArea(ring) > 20) water.push({ name, ring });
  }
}
const WATER_BOXES = water.map((w) => ringBox(w.ring));

// ---------- 公园绿地 ----------
const greenDbf = readDbf(path.join(SRC, '杭州 绿地.dbf'));
const green = [];
const seen = new Map();
for (const r of readShp(path.join(SRC, '杭州 绿地.shp'))) {
  const name = greenDbf.get(r.i, 'Name') || '';
  if (name.includes('医院')) continue;
  const [mx, mz] = toMap((r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2);
  if (dist(mx, mz) > RADIUS) continue;
  const ring = r.parts[0];
  if (!ring || ring.length < 3) continue;
  const area = ringArea(ring);
  if (area < 350) continue;
  const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...zs) - Math.min(...zs);
  if (bw > 650 || bh > 650) continue;
  const key = name + '|' + Math.round((Math.min(...xs) + Math.max(...xs)) / 2 / 20) + '|' + Math.round((Math.min(...zs) + Math.max(...zs)) / 2 / 20);
  const prev = seen.get(key);
  if (prev) { if (ring.length > prev.ring.length) prev.ring = ring; continue; }
  const ring2 = ring.slice();
  if (ring2[0][0] === ring2[ring2.length - 1][0] && ring2[0][1] === ring2[ring2.length - 1][1]) ring2.pop();
  const entry = { name, ring: ring2 };
  seen.set(key, entry);
  green.push(entry);
}
const GREEN_BOXES = green.map((g) => ringBox(g.ring));

// ---------- 上塘高架 ----------
const roadDbf = readDbf(path.join(SRC, '杭州 城市快速路.dbf'));
const viaduct = [];
for (const r of readShp(path.join(SRC, '杭州 城市快速路.shp'))) {
  const name = roadDbf.get(r.i, 'Name') || '';
  if (!name.includes('上塘高架')) continue;
  const [mx, mz] = toMap((r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2);
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
  const spacing = 12;
  for (let x = x0 + 8; x <= x1 - 8; x += spacing) {
    for (let z = z0 + 8; z <= z1 - 8; z += spacing) {
      const px = x + (rng() * 2 - 1) * 3.5, pz = z + (rng() * 2 - 1) * 3.5;
      if (!inRing(px, pz, g.ring)) continue;
      if (inBoxes(px, pz, WATER_BOXES)) continue;
      const species = rng() < 0.62 ? 0 : rng() < 0.72 ? 1 : 2;
      trees.push([+px.toFixed(1), +pz.toFixed(1), +(0.85 + rng() * 0.45).toFixed(2), species]);
    }
  }
}
if (trees.length > 900) {
  const step = trees.length / 900;
  const sampled = [];
  for (let i = 0; i < 900; i++) sampled.push(trees[Math.floor(i * step)]);
  trees.length = 0;
  trees.push(...sampled);
}

// ---------- 行道树（主路两侧，避开院区/水面/绿地/建筑） ----------
const roadAllDbf = readDbf(path.join(SRC, '路网.dbf'));
const roadAll = readShp(path.join(SRC, '路网.shp'));
// width 字段为“米×10”的道路宽度码（30/55/130 → 3.0/5.5/13.0m）
const roadWidth = (i) => {
  const v = parseFloat(roadAllDbf.get(i, 'width'));
  return isFinite(v) && v > 0 ? v / 10 : 5.5;
};
const streetTrees = [];
let streetTotal = 0;
for (const r of roadAll) {
  const wM = roadWidth(r.i);
  if (wM < 2) continue;
  const [mx, mz] = toMap((r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2);
  if (dist(mx, mz) > RADIUS) continue;
  const offset = wM / 2 + 2.4;
  for (const p of r.parts) {
    const parts = clipLineCircle(p, RADIUS - 4);
    for (const part of parts) {
      for (let i = 1; i < part.length; i++) {
        const a = part[i - 1], b = part[i];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < 6) continue;
        streetTotal += Math.floor(len / 26) * 2;
        const nx = -dz / len, nz = dx / len;
        for (let t = 10; t < len; t += 26) {
          const x = a[0] + (dx * t) / len, z = a[1] + (dz * t) / len;
          for (const side of [-1, 1]) {
            const px = x + nx * offset * side, pz = z + nz * offset * side;
            if (dist(px, pz) > RADIUS - 10) continue;
            if (px > CAMPUS.x0 && px < CAMPUS.x1 && pz > CAMPUS.z0 && pz < CAMPUS.z1) continue;
            if (inBoxes(px, pz, WATER_BOXES) || inBoxes(px, pz, GREEN_BOXES)) continue;
            if (inBoxes(px, pz, CITY_BOXES)) continue;
            const species = rng() < 0.8 ? 0 : 1;
            streetTrees.push([+px.toFixed(1), +pz.toFixed(1), +(0.68 + rng() * 0.28).toFixed(2), species]);
          }
        }
      }
    }
  }
}
const streetBefore = streetTrees.length;
if (streetTrees.length > 800) {
  const step = streetTrees.length / 800;
  const sampled = [];
  for (let i = 0; i < 800; i++) sampled.push(streetTrees[Math.floor(i * step)]);
  streetTrees.length = 0;
  streetTrees.push(...sampled);
}

// ---------- 桥梁 / 公园步道 ----------
const pedDbf = readDbf(path.join(SRC, '杭州 行人道路.dbf'));
const pedAll = readShp(path.join(SRC, '杭州 行人道路.shp'));
const BRIDGE_NAMES = new Set(['朝晖桥', '青园桥', '德胜路桥', '映月桥']);
const bridgeMap = new Map();
for (const r of pedAll) {
  const name = pedDbf.get(r.i, 'Name') || '';
  if (!BRIDGE_NAMES.has(name)) continue;
  const parts = [];
  for (const p of r.parts) for (const c of clipLineCircle(p, RADIUS)) parts.push(c);
  if (!parts.length) continue;
  if (!bridgeMap.has(name)) bridgeMap.set(name, []);
  bridgeMap.get(name).push(...parts);
}
const bridges = [...bridgeMap.entries()].map(([name, parts]) => ({ name, parts }));

const footpaths = [];
for (const r of pedAll) {
  for (const p of r.parts) {
    for (const c of clipLineCircle(p, RADIUS)) {
      if (c.length < 2) continue;
      const mid = c[Math.floor(c.length / 2)];
      if (!inBoxes(mid[0], mid[1], GREEN_BOXES)) continue;
      footpaths.push(c.map((q) => [+q[0].toFixed(1), +q[1].toFixed(1)]));
    }
  }
}

// ---------- 地面路网（快速路/省道/一级路；宽度码 30/55/130 → 3.0/5.5/13.0m） ----------
const roads = [];
for (const r of roadAll) {
  const fc = roadAllDbf.get(r.i, 'fclass') || 'road';
  const wM = roadWidth(r.i);
  if (wM < 2) continue;
  const name = roadAllDbf.get(r.i, 'Name') || '';
  const [mx, mz] = toMap((r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2);
  if (dist(mx, mz) > RADIUS) continue;
  const parts = [];
  for (const p of r.parts) {
    for (const c of clipLineCircle(p, RADIUS)) {
      const mid = c[Math.floor(c.length / 2)];
      if (mid[0] > CAMPUS.x0 && mid[0] < CAMPUS.x1 && mid[1] > CAMPUS.z0 && mid[1] < CAMPUS.z1) continue;
      if (inBoxes(mid[0], mid[1], WATER_BOXES)) continue;
      parts.push(c);
    }
  }
  if (parts.length) roads.push({ fc, w: +wM.toFixed(1), name, parts });
}

// ---------- 重点建筑 / 公交场站（只取近院区） ----------
function collectAreas(file, minArea) {
  const dbf = readDbf(path.join(SRC, file + '.dbf'));
  const out = [];
  const seenArea = new Set();
  for (const r of readShp(path.join(SRC, file + '.shp'))) {
    const ring = r.parts[0];
    if (!ring || ring.length < 3) continue;
    const area = ringArea(ring);
    if (area < minArea) continue;
    const [cx, cz] = ringCentroid(ring);
    if (dist(cx, cz) > RADIUS) continue;
    const name = dbf.get(r.i, 'Name') || '';
    const key = name + '|' + Math.round(cx / 20) + '|' + Math.round(cz / 20);
    if (seenArea.has(key)) continue;
    seenArea.add(key);
    out.push({
      name, area: +area.toFixed(0),
      ring: ring.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1)]),
    });
  }
  return out;
}
const complexes = collectAreas('杭州 综合建筑物', 300);
const busDepots = collectAreas('杭州 公交站场区域', 300);

// ---------- 总平图树木（医院周边真实树位） ----------
let campusTrees = [];
try {
  const rawTrees = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/trees.json'), 'utf8'));
  campusTrees = rawTrees
    .filter((t, i) => i % 3 === 0 && Number.isFinite(t.x) && Number.isFinite(t.z) && dist(t.x, t.z) <= RADIUS)
    .map((t, i) => [+t.x.toFixed(1), +t.z.toFixed(1), +Math.min(1.30, t.s).toFixed(2), i % 9 === 0 ? 2 : (i % 4 === 0 ? 1 : 0)]);
} catch (e) {
  console.warn('总平图树木读取失败:', e.message);
}

// ---------- 功能分区（给建筑立面/配色分类用） ----------
const zones = [];
{
  const seenZone = new Map();
  const sets = [
    ['杭州 住宅区', 'residential', 800],
    ['杭州 学校', 'school', 400],
    ['杭州 医院区域', 'hospital', 200],
    ['杭州 商业区', 'commercial', 500],
    ['杭州 购物广场区域', 'commercial', 300],
    ['杭州 体育场', 'sports', 500],
  ];
  for (const [file, cls, minArea] of sets) {
    const dbf = readDbf(path.join(SRC, file + '.dbf'));
    for (const r of readShp(path.join(SRC, file + '.shp'))) {
      const ring = r.parts[0];
      if (!ring || ring.length < 3) continue;
      const area = ringArea(ring);
      if (area < minArea) continue;
      const [cx, cz] = ringCentroid(ring);
      if (dist(cx, cz) > RADIUS) continue;
      const name = dbf.get(r.i, 'Name') || '';
      const key = cls + '|' + Math.round(cx / 25) + '|' + Math.round(cz / 25);
      const prev = seenZone.get(key);
      if (prev && prev.area >= area) continue;
      const entry = { cls, name, ring: ring.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1)]), area: +area.toFixed(0) };
      seenZone.set(key, entry);
    }
  }
  zones.push(...[...seenZone.values()].map(({ area, ...z }) => z));
}

// ---------- 标注 ----------
const labels = [];
for (const w of water) {
  if (!w.name || (w.name !== '京杭运河' && w.name !== '上塘河')) continue;
  if (labels.some((l) => l.text === w.name)) continue;
  const c = nearestRingPoint(w.ring);
  labels.push({ text: w.name, x: +c[0].toFixed(1), z: +c[1].toFixed(1), kind: 'water' });
}
{
  let bestD = 1e30, bp = null;
  for (const v of viaduct) for (const p of v.parts) for (const q of p) {
    const d = q[0] * q[0] + q[1] * q[1];
    if (d < bestD) { bestD = d; bp = q; }
  }
  if (bp) labels.push({ text: '上塘高架', x: +bp[0].toFixed(1), z: +bp[1].toFixed(1), kind: 'viaduct' });
}
{
  const park = green.find((g) => g.name.includes('朝晖公园')) || green[0];
  if (park) {
    const c = ringCentroid(park.ring);
    labels.push({ text: park.name, x: +c[0].toFixed(1), z: +c[1].toFixed(1), kind: 'park' });
  }
}

// 路名
const ROAD_LABELS = ['上塘路', '绍兴路', '文晖路', '德胜路', '潮王路', '东新路', '中山北路', '朝晖路'];
const roadLabels = [];
{
  const byName = new Map();
  for (const r of roadAll) {
    const name = roadAllDbf.get(r.i, 'Name') || '';
    if (!ROAD_LABELS.includes(name)) continue;
    for (const p of r.parts) {
      for (const c of clipLineCircle(p, RADIUS)) {
        let bestPart = null, bestD = 1e30;
        // 取该段的中点作为路名位置，选离院区最近的一段
        for (let i = 1; i < c.length; i++) {
          const a = c[i - 1], b = c[i];
          const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
          const d = dist(mx, mz);
          if (d < bestD) { bestD = d; bestPart = [mx, mz]; }
        }
        if (bestPart) {
          const prev = byName.get(name);
          if (!prev || bestD < prev.d) byName.set(name, { text: name, x: +bestPart[0].toFixed(1), z: +bestPart[1].toFixed(1), kind: 'road', d: bestD });
        }
      }
    }
  }
  for (const e of byName.values()) { delete e.d; roadLabels.push(e); }
}

// POI
function collectPoi(file, wanted, kind) {
  if (!fs.existsSync(file)) return [];
  const D = readDbf(file.replace(/\.shp$/i, '.dbf'));
  const found = new Map();
  for (const r of readShp(file)) {
    const n = D.get(r.i, 'Name');
    if (!wanted.includes(n)) continue;
    const [x, z] = toMap((r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2);
    const d = dist(x, z);
    if (d > RADIUS) continue;
    const prev = found.get(n);
    if (!prev || d < prev.d) found.set(n, { text: n, x: +x.toFixed(1), z: +z.toFixed(1), kind, d });
  }
  return [...found.values()].map((e) => { delete e.d; return e; });
}
const poiLabels = [
  ...collectPoi(path.join(SRC, '杭州 住宅区.shp'), ['朝晖四小区', '朝晖九区'], 'poi'),
  ...collectPoi(path.join(SRC, '杭州 学校.shp'), ['浙江工业大学', '朝晖中学'], 'poi'),
  ...collectPoi(path.join(SRC, '杭州 医院区域.shp'), ['市第六人民医院'], 'poi'),
  ...collectPoi(path.join(SRC, '杭州 公交站场区域.shp'), ['朝晖五区'], 'poi'),
  ...collectPoi(path.join(SRC, '杭州 体育场.shp'), ['杭州游泳健身中心-球类馆'], 'poi').map((e) => ({ ...e, text: '游泳健身中心' })),
];

const out = `// 医院周边 3D 环境（WGS84 -> BASEMAP 地图米，x=东 z=南）
// 由 tools/extract-context.js 生成：--radius=${RADIUS}
// 水系/绿地：杭州 水系.shp / 杭州 绿地.shp；高架：杭州 城市快速路.shp(Name=上塘高架)；
// 行道树/路名/地面路网：路网.shp（width 为米×10：30/55/130）；桥/公园步道：杭州 行人道路.shp；
// 公交场站/重点建筑：杭州 公交站场区域.shp / 杭州 综合建筑物.shp；
// 总平树：data/trees.json（每 3 棵取 1 棵，避免院区树木过密遮住院区）；
// zones：住宅区/学校/医院/购物/体育场功能区，供建筑立面与配色分类
export const CONTEXT = ${JSON.stringify({
  radius: RADIUS, water, green, viaduct, trees, labels, zones,
  roadLabels, poiLabels, streetTrees, bridges, footpaths, roads,
  sports: zones.filter((z) => z.cls === 'sports'),
  complexes, busDepots, campusTrees,
}, null, 0)};
`;
const target = path.resolve(__dirname, '../data/context.js');
fs.writeFileSync(target, out);
console.log('water', water.length, 'green', green.length, 'viaduct parts', viaduct.reduce((s, v) => s + v.parts.length, 0),
  'parkTrees', trees.length, 'streetTrees', streetTrees.length, '(candidates', streetBefore + ')',
  'footpaths', footpaths.length, 'sports', zones.filter((z) => z.cls === 'sports').length,
  'complexes', complexes.length, 'busDepots', busDepots.length, 'campusTrees', campusTrees.length,
  'bridges', bridges.length, 'roads', roads.length, 'zones', zones.length, 'labels', labels.length, 'roadLabels', roadLabels.length, 'poiLabels', poiLabels.length);
console.log('→', target, (fs.statSync(target).size / 1024).toFixed(1) + 'KB');
