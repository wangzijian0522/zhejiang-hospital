const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function handleTwinResource(req, res, twinRelay) {
  if (req.url.split('?')[0] !== '/twin-resource') return false;
  const q = req.url.split('?')[1] || '';
  const rid = new URLSearchParams(q).get('rid');
  if (!twinRelay || !rid) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('missing rid or relay');
    return true;
  }
  twinRelay.getResource(rid)
    .then((json) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(json));
    })
    .catch((e) => {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('resource failed: ' + e.message);
    });
  return true;
}

const BITMAP_URL = /^\/tdt\/([a-z_]+)\/(\d+)\/(\d+)\/(\d+)$/;
// 天地图浏览器端密钥：服务端代取瓦片时可隐藏 key；可用 TDT_TK 环境变量覆盖
const TDT_TK = process.env.TDT_TK || '4cdaaf6bd0bf76f314152dc58d2db861';
// 天地图会按 UA 判定“浏览器端 Key”，非浏览器 UA 直接 403（301012）
const TDT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let twinRelay = null;

const server = http.createServer((req, res) => {
  if (handleTwinResource(req, res, twinRelay)) return;
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  // 天地图瓦片代理：/tdt/{layerSet}/{z}/{x}/{y}
  const tdtMatch = urlPath.match(BITMAP_URL);
  if (tdtMatch) {
    const [, layerSet, z, x, y] = tdtMatch;
    // 路径是图层集（img_w/vec_w/cva_w），WMTS 的 LAYER 参数要的是图层名（img/vec/cva）
    const layerName = layerSet.replace(/_w$/, '');
    const host = ['t0', 't1', 't2', 't3'][(Number(x) + Number(y)) % 4] + '.tianditu.gov.cn';
    const up = `https://${host}/${layerSet}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layerName}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&tk=${encodeURIComponent(TDT_TK)}`;
    https.get(up, { headers: { 'User-Agent': TDT_UA, 'Referer': 'http://localhost/' } }, (u) => {
      if (u.statusCode !== 200) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('tianditu upstream ' + u.statusCode);
        u.resume();
        return;
      }
      res.writeHead(200, {
        'Content-Type': u.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      });
      u.pipe(res);
    }).on('error', () => { res.writeHead(502); res.end('proxy error'); });
    return;
  }
  if (urlPath === '/') urlPath = '/digital-twin/index.html';
  if (urlPath === '/') urlPath = '/digital-twin/index.html';
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': st.size,
    });
    fs.createReadStream(file).pipe(res);
  });
});

// 中控 openTwin 实时数据中继（WebSocket /twin）
try {
  const { attachTwinRelay } = require('./twin-relay.js');
  twinRelay = attachTwinRelay(server);
} catch (e) {
  console.warn('[twin-relay] 中继不可用（缺少 ws 依赖？）:', e.message);
}

server.listen(PORT, () => {
  console.log(`数字孪生白膜服务已启动: http://localhost:${PORT}/digital-twin/`);
});
