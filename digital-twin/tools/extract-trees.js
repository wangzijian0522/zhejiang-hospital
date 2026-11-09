// 从医院总平1.jpg 提取树木位置 → data/trees.json
// 树木在总平图中为深绿色圆点（高饱和度），草坪为浅绿色（低饱和度）
// 用法: node digital-twin/tools/extract-trees.js
const { Jimp } = require('jimp');
const fs = require('fs');
const path = require('path');

const IMG_W = 5898, IMG_H = 3035, M = 10.5; // px/m
const HALF = 2;              // 降采样倍数（1/2）
const CELL = 26;             // 网格单元(half-res px) ≈ 5m
const MIN_PX = 5;            // 单元内最少树像素数

(async () => {
  const src = path.resolve(__dirname, '../assets/site-plan.jpg');
  const img = await Jimp.read(src);
  img.resize({ w: Math.round(IMG_W / HALF) });
  const { width, height, data } = img.bitmap;

  const isTree = (i) => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    return g > r + 35 && g > b + 20 && g >= 65 && g <= 180;
  };

  const hits = [];
  for (let cy = 0; cy < height; cy += CELL) {
    for (let cx = 0; cx < width; cx += CELL) {
      let cnt = 0, sx = 0, sy = 0;
      const yEnd = Math.min(cy + CELL, height), xEnd = Math.min(cx + CELL, width);
      for (let y = cy; y < yEnd; y++) {
        for (let x = cx; x < xEnd; x++) {
          if (isTree((y * width + x) * 4)) { cnt++; sx += x; sy += y; }
        }
      }
      if (cnt >= MIN_PX) hits.push({ x: (sx / cnt) * HALF, y: (sy / cnt) * HALF, n: cnt });
    }
  }

  const trees = hits.map((t) => ({
    x: +((t.x - IMG_W / 2) / M).toFixed(2),
    z: +((t.y - IMG_H / 2) / M).toFixed(2),
    s: +(0.75 + Math.min(1.1, t.n / 90) + Math.random() * 0.35).toFixed(2),
  }));

  fs.writeFileSync(path.resolve(__dirname, '../data/trees.json'), JSON.stringify(trees));
  console.log('trees:', trees.length, '→ data/trees.json');

  // 调试图：红点标记检测到的树
  const full = await Jimp.read(src);
  for (const t of hits) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = Math.round(t.x) + dx, y = Math.round(t.y) + dy;
      if (x >= 0 && y >= 0 && x < full.bitmap.width && y < full.bitmap.height) {
        full.setPixelColor(0xff0000ff, x, y);
      }
    }
  }
  await full.write(path.resolve(__dirname, '../assets/trees-debug.png'));
  console.log('debug → assets/trees-debug.png');
})();
