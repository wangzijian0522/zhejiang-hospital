// 依据天地图 z18 卫星影像标定的周边建筑体量 → data/surroundings.js
// 影像参数：中心 120.16375,30.28745；z18 地面分辨率 0.516m/px；50m=97px
// 行定义：[图像 y, 起始 x, 数量, 行倾角(度，屏幕向下为正)]，均为 z18 影像像素
const { Jimp } = require('/Users/ccchen/Documents/project/zhejiang-hospital/node_modules/jimp');
const fs = require('fs');
const path = require('path');

const MPP = 0.516;          // z18 地面分辨率
const CX = 659, CY = 530;   // 影像中心像素
const SPACING = 80;         // 建筑间距 px（≈45m）
const LEN = 64;             // 建筑长 px（≈34m）
const DEP = 24;             // 建筑进深 px（≈12m）
const TILT = -12;           // 行列倾角（影像上向右上倾）

// 上塘路在影像中的中心线：x = 250 + 0.383*y
const roadX = (y) => 250 + 0.383 * y;

const ROWS = [
  // 北侧
  { y: 95, x: 350, n: 9 },
  { y: 170, x: 370, n: 9 },
  { y: 245, x: 390, n: 9 },
  { y: 320, x: 410, n: 9 },
  // 南侧
  { y: 800, x: 620, n: 7 },
  { y: 875, x: 640, n: 7 },
  { y: 950, x: 660, n: 7 },
  { y: 1025, x: 680, n: 7 },
  { y: 1100, x: 700, n: 7 },
  // 西侧
  { y: 70, x: 20, n: 5 },
  { y: 145, x: 20, n: 5 },
  { y: 920, x: 25, n: 5 },
  { y: 995, x: 25, n: 5 },
  { y: 1070, x: 25, n: 5 },
  { y: 1145, x: 25, n: 5 },
  // 院区东侧
  { y: 340, x: 950, n: 3 },
  { y: 420, x: 950, n: 3 },
  { y: 500, x: 950, n: 3 },
  { y: 580, x: 950, n: 3 },
];

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = rng(20261113);

function build() {
  const out = [];
  for (const row of ROWS) {
    for (let i = 0; i < row.n; i++) {
      const px = row.x + i * SPACING + (rnd() - 0.5) * 4;
      const py = row.y + i * SPACING * Math.tan((TILT * Math.PI) / 180) + (rnd() - 0.5) * 3;
      // 避开医院院区（影像 x 420..900, y 330..660）
      if (px > 400 && px < 920 && py > 320 && py < 670) continue;
      // 避开上塘路路面
      if (Math.abs(px - roadX(py)) < 46) continue;
      const east = (px - CX) * MPP;
      const north = (CY - py) * MPP;
      const h = 12 + Math.round(rnd() * 8) + (rnd() < 0.15 ? 6 : 0);
      out.push({
        x: +(east).toFixed(1),
        z: +(-north).toFixed(1),
        w: +(LEN * MPP).toFixed(1),
        d: +(DEP * MPP).toFixed(1),
        h,
        rot: +(-TILT).toFixed(1),
      });
    }
  }
  return out;
}

const data = build();

(async () => {
  if (process.argv.includes('--preview')) {
    const img = await Jimp.read('/tmp/raw_18.jpg');
    const cos = Math.cos((TILT * Math.PI) / 180), sin = Math.sin((TILT * Math.PI) / 180);
    for (const b of data) {
      const px = CX + b.x / MPP, py = CY - (-b.z) / MPP;
      const hw = b.w / MPP / 2, hd = b.d / MPP / 2;
      const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [px + u * cos - v * sin, py + u * sin + v * cos]);
      for (let k = 0; k < 4; k++) {
        const a = pts[k], c = pts[(k + 1) % 4];
        const n = Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]));
        for (let s = 0; s <= n; s++) {
          const x = Math.round(a[0] + (c[0] - a[0]) * s / n), y = Math.round(a[1] + (c[1] - a[1]) * s / n);
          if (x >= 0 && y >= 0 && x < img.bitmap.width && y < img.bitmap.height) img.setPixelColor(0xff2a2aff, x, y);
        }
      }
    }
    await img.write('/tmp/surround_preview.jpg');
    console.log('preview → /tmp/surround_preview.jpg', data.length, 'boxes');
  }
  const target = path.resolve(__dirname, '../data/surroundings.js');
  fs.writeFileSync(target, '// 周边建筑体量（依据天地图 z18 卫星影像标定，坐标相对 BASEMAP.center，单位米）\n// x=东, z=南；w/d=边长；rot=平面旋转(度)\nexport const SURROUNDINGS = ' + JSON.stringify(data) + ';\n');
  console.log('written', target, data.length, 'boxes');
})();
