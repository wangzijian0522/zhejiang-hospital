// 从杭州市建筑面 shp（百度建筑，WGS84，含 height 字段）提取医院周边体量
// 用法：node tools/extract-city.js [--radius=300] [--shp=/path/百度建筑.shp]
// 输出：data/city.js  export const CITY = { radius, buildings: [[h, x0,z0, ...], ...] }
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const SHP = args.shp || process.env.CITY_SHP || '/Users/ccchen/Downloads/杭州数据/杭州 分块/百度建筑.shp';
const SHP_BASE = SHP.replace(/\.shp$/i, '');
const RADIUS = +(args.radius || 300);
const LON = 120.16375, LAT = 30.28745; // BASEMAP.center
const R = 6378137;
const mercX = (lon) => ((lon + 180) / 360) * 2 * Math.PI * R;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2 * 2 * Math.PI * R;
const X0 = mercX(LON), Y0 = mercY(LAT), COS = Math.cos((LAT * Math.PI) / 180);
// 院区（精模覆盖区域）排除：地图坐标矩形
const EXCLUDE = { x0: -160, x1: 145, z0: -115, z1: 95 };

function readDbf(file) {
  const buf = fs.readFileSync(file);
  const nrec = buf.readUInt32LE(4), hlen = buf.readUInt16LE(8), rlen = buf.readUInt16LE(10);
  const fields = [];
  let p = 32;
  while (buf[p] !== 0x0d) { fields.push({ name: buf.slice(p, p + 11).toString('utf8').replace(/\0+$/, ''), len: buf[p + 16] }); p += 32; }
  const get = (i, name) => {
    let q = hlen + i * rlen + 1;
    for (const f of fields) { if (f.name === name) return buf.slice(q, q + f.len).toString('utf8').trim(); q += f.len; }
    return '';
  };
  return { nrec, get };
}

const shp = fs.readFileSync(`${SHP_BASE}.shp`);
const shx = fs.readFileSync(`${SHP_BASE}.shx`);
const dbf = readDbf(`${SHP_BASE}.dbf`);

// 以“点到圆心距离”筛选；只保留外环（parts[0]）
const d = (RADIUS + 250) / 111320; // 预筛 bbox（度）
let count = 0;
const buildings = [];
for (let i = 0; i < dbf.nrec; i++) {
  const off = shx.readInt32BE(100 + i * 8) * 2;
  if (shp.readInt32LE(off + 8) !== 5) continue;
  const x0 = shp.readDoubleLE(off + 12), y0 = shp.readDoubleLE(off + 20);
  const x1 = shp.readDoubleLE(off + 28), y1 = shp.readDoubleLE(off + 36);
  if (x1 < LON - d || x0 > LON + d || y1 < LAT - d || y0 > LAT + d) continue;
  const numParts = shp.readInt32LE(off + 44);
  const numPoints = shp.readInt32LE(off + 48);
  if (!numParts || !numPoints) continue;
  const partsOff = off + 52, pointsOff = partsOff + numParts * 4;
  const end = numParts > 1 ? shp.readInt32LE(partsOff + 4) : numPoints;
  // 轮廓点 → 地图坐标
  const ring = [];
  let cx = 0, cz = 0;
  for (let k = 0; k < end; k++) {
    const lon = shp.readDoubleLE(pointsOff + k * 16), lat = shp.readDoubleLE(pointsOff + k * 16 + 8);
    const x = (mercX(lon) - X0) * COS;
    const z = (mercY(lat) - Y0) * COS; // 北为负、南为正
    ring.push(x, z);
    cx += x; cz += z;
  }
  cx /= end; cz /= end;
  if (Math.hypot(cx, cz) > RADIUS) continue;
  if (cx > EXCLUDE.x0 && cx < EXCLUDE.x1 && cz > EXCLUDE.z0 && cz < EXCLUDE.z1) continue;
  const hRaw = parseFloat(dbf.get(i, 'height'));
  if (!isFinite(hRaw) || hRaw <= 0) continue;
  const h = Math.min(200, Math.max(3, hRaw));
  if (ring.length < 6) continue; // 至少 3 个点
  // 保留两位小数
  const pts = ring.map((v) => +v.toFixed(2));
  buildings.push([+h.toFixed(1), ...pts]);
  count++;
}

buildings.sort((a, b) => Math.hypot(a[1], a[2]) - Math.hypot(b[1], b[2]));
const target = path.resolve(__dirname, '../data/city.js');
fs.writeFileSync(target,
  `// 医院周边真实建筑体量（百度建筑 2020，WGS84，height 单位米）\n` +
  `// 由 tools/extract-city.js 生成：--radius=${RADIUS}\n` +
  `// buildings: [height, x0,z0, x1,z1, ...]（外环，地图坐标相对 BASEMAP.center，x=东 z=南）\n` +
  `export const CITY = { radius: ${RADIUS}, buildings: ${JSON.stringify(buildings)} };\n`);
console.log('extracted', count, 'buildings →', target);
