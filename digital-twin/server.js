const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

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

const RELAY_HINT = '中控凭证未配置：把 twin-relay.credentials.json 放到 digital-twin/ 目录，或设置环境变量 TWIN_CLIENT_ID/TWIN_CLIENT_SECRET/TWIN_ACCESS_KEY_ID/TWIN_ACCESS_KEY_SECRET，重启服务。';

function handleTwinResource(req, res, twinRelay) {
  if (req.url.split('?')[0] !== '/twin-resource') return false;
  if (!twinRelay || twinRelay.configured === false || typeof twinRelay.getResource !== 'function') {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(RELAY_HINT);
    return true;
  }
  const q = req.url.split('?')[1] || '';
  const rid = new URLSearchParams(q).get('rid');
  if (!rid) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('missing rid');
    return true;
  }
  const etag = 'W/"' + crypto.createHash('sha1').update(rid).digest('hex').slice(0, 16) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'public, max-age=86400, immutable' });
    res.end();
    return true;
  }
  twinRelay.getResource(rid)
    .then((json) => {
      const body = Buffer.from(JSON.stringify(json), 'utf8');
      const accept = String(req.headers['accept-encoding'] || '');
      const zipped = /\bgzip\b/.test(accept) ? zlib.gzipSync(body) : body;
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        // rid 里带内容哈希，同一 rid 的内容不会变
        'Cache-Control': 'public, max-age=86400, immutable',
        'ETag': etag,
        'Vary': 'Accept-Encoding',
        'Content-Length': zipped.length,
      };
      if (zipped !== body) headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(zipped);
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

// ---------- 静态资源的压缩与缓存 ----------
// 文本类按 Accept-Encoding 现压并缓存（同一个文件+mtime 只压一次）；
// 二进制（glb/jpg/png）本身已压缩，不再二次压缩。
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map']);
const zipCache = new Map();

// 缓存策略：第三方与 vendor 一年不变；模型 1 天；数据 10 分钟；页面 no-cache 走 ETag
function cachePolicy(urlPath) {
  if (urlPath.startsWith('/node_modules/') || urlPath.startsWith('/digital-twin/vendor/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (urlPath.startsWith('/models/')) return 'public, max-age=86400';
  if (urlPath.startsWith('/digital-twin/assets/')) return 'public, max-age=604800';
  if (urlPath.startsWith('/digital-twin/data/')) return 'public, max-age=600';
  return 'no-cache';
}

function serveStatic(req, res, file, urlPath, st) {
  const ext = path.extname(file).toLowerCase();
  const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cachePolicy(urlPath),
    'ETag': etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Vary': 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const accept = String(req.headers['accept-encoding'] || '');
  const canZip = COMPRESSIBLE.has(ext) && st.size > 1024 && st.size < 8 * 1024 * 1024;
  const enc = !canZip ? null : /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  if (!enc) {
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
    return;
  }
  const key = file + ':' + Math.floor(st.mtimeMs) + ':' + enc;
  const cached = zipCache.get(key);
  if (cached) {
    headers['Content-Encoding'] = enc;
    headers['Content-Length'] = cached.length;
    res.writeHead(200, headers);
    res.end(cached);
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('read error'); return; }
    let body;
    try {
      body = enc === 'br'
        ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 } })
        : zlib.gzipSync(buf, { level: 9 });
    } catch {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      res.end(buf);
      return;
    }
    if (zipCache.size > 64) zipCache.clear();
    zipCache.set(key, body);
    headers['Content-Encoding'] = enc;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
  });
}

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
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  // 凭证与 dotfiles 永远不走静态资源，避免本地密钥被浏览器直接下载
  const lowerPath = urlPath.toLowerCase();
  if (lowerPath === '/digital-twin/twin-relay.credentials.json'
    || lowerPath === '/digital-twin/twin-relay.js'
    || lowerPath.split('/').some((seg) => seg.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + urlPath);
    return;
  }
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath); return;
    }
    serveStatic(req, res, file, urlPath, st);
  });
});

// 中控 openTwin 实时数据中继（WebSocket /twin + CAD 资源 /twin-resource）
// 优先加载含真实凭证的 twin-relay.js（gitignore 排除，不入库）；
// 仓库协作无该文件时退回示例模板，未填凭证则给出明确提示而不是崩溃。
function attachTwinFallback() {
  server.on('upgrade', (req, socket) => {
    let pathname = '/';
    try { pathname = decodeURIComponent(req.url.split('?')[0]); } catch (_) {}
    if (pathname !== '/twin') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    const payload = JSON.stringify({
      schemaVersion: '1.0', type: 'error', connectionId: null, workspaceId: null, seq: null, sentAt: new Date().toISOString(),
      data: { code: 'RELAY_UNCONFIGURED', message: RELAY_HINT },
    });
    const len = Buffer.byteLength(payload);
    let frame;
    if (len < 126) {
      frame = Buffer.alloc(2 + len);
      frame[0] = 0x81; frame[1] = len;
      frame.write(payload, 2);
    } else {
      frame = Buffer.alloc(4 + len);
      frame[0] = 0x81; frame[1] = 126;
      frame.writeUInt16BE(len, 2);
      frame.write(payload, 4);
    }
    socket.write(frame, () => socket.end());
  });
}
let twinRelay = null;
try {
  let attach = null;
  try {
    attach = require('./twin-relay.js').attachTwinRelay;
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    attach = require('./twin-relay.example.js').attachTwinRelay;
  }
  twinRelay = attach(server);
} catch (e) {
  console.warn('[twin-relay] 中继不可用（缺少 ws 依赖？）:', e.message);
}
if (!twinRelay || twinRelay.configured === false) {
  console.warn('[twin-relay] ' + RELAY_HINT);
  attachTwinFallback();
}

server.listen(PORT, () => {
  console.log(`数字孪生白膜服务已启动: http://localhost:${PORT}/digital-twin/`);
});
