// 中控 openTwin 数据中继：凭证只在服务端，浏览器通过本服务 /twin 的 WebSocket 获取实时数据
// 使用方式（三选一）：
//   1. 把同事私下发来的 twin-relay.credentials.json 放到本目录（已 gitignore，不入库）；
//   2. 设置环境变量 TWIN_CLIENT_ID / TWIN_CLIENT_SECRET / TWIN_ACCESS_KEY_ID / TWIN_ACCESS_KEY_SECRET（可选 TWIN_WORKSPACE_ID）；
//   3. 复制本文件为 twin-relay.js 并直接把 YOUR_* 替换为中控提供的凭证。
// 完成后重启服务即可。
const { WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');

let localCred = null;
try {
  localCred = JSON.parse(fs.readFileSync(path.join(__dirname, 'twin-relay.credentials.json'), 'utf8'));
} catch (_) {}

const env = process.env;
const CFG = {
  base: env.TWIN_BASE || (localCred && localCred.base) || 'https://yjrobot.rxwysystem.com/api',
  wsUrl: env.TWIN_WS_URL || (localCred && localCred.wsUrl) || 'wss://yjrobot.rxwysystem.com/api/openTwin/v1/stream',
  oauth: {
    grant_type: 'urn:robot:params:oauth:grant-type:open-access-token',
    client_id: env.TWIN_CLIENT_ID || (localCred && localCred.client_id) || 'YOUR_CLIENT_ID',
    client_secret: env.TWIN_CLIENT_SECRET || (localCred && localCred.client_secret) || 'YOUR_CLIENT_SECRET',
    access_key_id: env.TWIN_ACCESS_KEY_ID || (localCred && localCred.access_key_id) || 'YOUR_ACCESS_KEY_ID',
    access_key_secret: env.TWIN_ACCESS_KEY_SECRET || (localCred && localCred.access_key_secret) || 'YOUR_ACCESS_KEY_SECRET',
  },
  workspaceId: env.TWIN_WORKSPACE_ID || (localCred && localCred.workspaceId) || '4',
};

function isConfigured() {
  const o = CFG.oauth;
  return o.client_id !== 'YOUR_CLIENT_ID' && o.client_secret !== 'YOUR_CLIENT_SECRET'
    && o.access_key_id !== 'YOUR_ACCESS_KEY_ID' && o.access_key_secret !== 'YOUR_ACCESS_KEY_SECRET';
}

const COLLECTIONS = ['scenes', 'floors', 'mapRegistrations', 'robots', 'tasks', 'paths', 'elevators'];
const KEY_FIELD = {
  scenes: 'sceneId',
  floors: 'floorKey',        // 组合键 sceneId+floorKey
  mapRegistrations: 'mapAssetId', // 组合键 sceneId+mapAssetId
  robots: 'robotId',
  tasks: 'intakeId',
  paths: 'pathId',
  elevators: 'controllerId',
};
// TEMP-TEST: 注入一台就位测试机器人，验证前端绘制管线（仅测试用）
const FAKE_ROBOT = process.env.TWIN_TEST_FAKE === '1' ? {
  robotId: 'TEST-1', sn: 'TEST', name: '测试送药车', brand: 'yj', model: 'YJ-Drug-01', enabled: true, dataSource: 'simulation',
  state: { onlineStatus: 'online', operationStatus: 'free', batteryPercent: 90, isCharging: false, freshness: 'fresh', observedAt: null, deviceReportedAt: null, reasonCode: null },
  map: { mapAssetId: null, nativeMapName: null, resolutionStatus: 'resolved', reasonCode: null },
  cadLocations: [{ sceneId: '1', buildingId: 'A', floorKey: 'A-1', coordinateSystem: 'cad-local-xy-m-v1', projectionStatus: 'ready', reasonCode: null, cadPose: { x: 0, y: 0, yawRad: 0.5 }, observedAt: null, mapAssetId: null }],
  currentTaskRef: null, taskRefs: [],
} : null;

function keyOf(col, e) {
  if (col === 'floors') return e.sceneId + '/' + e.floorKey;
  if (col === 'mapRegistrations') return e.sceneId + '/' + e.mapAssetId;
  return e[KEY_FIELD[col]];
}

class TwinRelay {
  constructor(wss) {
    this.wss = wss;
    this.token = null;         // { value, expiresAt }
    this.upstream = null;
    this.viewers = new Set();
    this.mirror = { catalogVersion: null, coordinateEpoch: null, entities: {} };
    COLLECTIONS.forEach((c) => { this.mirror.entities[c] = new Map(); });
    if (FAKE_ROBOT) this.mirror.entities.robots.set(FAKE_ROBOT.robotId, FAKE_ROBOT);
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.authenticated = false;
    this.lastSnapshotAt = null;
  }

  log(...a) { console.log('[twin-relay]', ...a); }

  // ---------- 观众（浏览器） ----------
  attachViewer(ws) {
    this.viewers.add(ws);
    ws.on('close', () => {
      this.viewers.delete(ws);
      if (this.viewers.size === 0 && this.upstream) {
        this.log('no viewers, closing upstream');
        try { this.upstream.close(); } catch (_) {}
      }
    });
    ws.on('error', () => {});
    // 发送当前镜像合成的快照
    this.sendSyntheticSnapshot(ws);
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      this.connectUpstream();
    }
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const v of this.viewers) {
      if (v.readyState === WebSocket.OPEN) { try { v.send(s); } catch (_) {} }
    }
  }

  sendSyntheticSnapshot(ws) {
    const now = new Date().toISOString();
    const counts = {};
    const entities = {};
    COLLECTIONS.forEach((c) => {
      const arr = Array.from(this.mirror.entities[c].values());
      counts[c] = arr.length;
      entities[c] = arr;
    });
    const snapId = 'relay-' + Date.now();
    const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch (_) {} };
    send({
      schemaVersion: '1.0', type: 'snapshot.begin', connectionId: 'relay-' + Math.random().toString(36).slice(2), workspaceId: CFG.workspaceId, seq: 1, sentAt: now,
      data: {
        snapshotId: snapId, snapshotAt: this.lastSnapshotAt || now,
        catalogVersion: this.mirror.catalogVersion || 'relay-mirror', coordinateEpoch: this.mirror.coordinateEpoch || 'relay-epoch',
        partCount: 1, counts, taskWindow: { includeAllNonTerminal: true, terminalFrom: null, terminalTo: null }, invalidatePrevious: false,
      },
    });
    send({
      schemaVersion: '1.0', type: 'snapshot.part', connectionId: 'relay-' + Math.random().toString(36).slice(2), workspaceId: CFG.workspaceId, seq: 2, sentAt: now,
      data: { snapshotId: snapId, partIndex: 0, entities, entityFragments: [] },
    });
    send({
      schemaVersion: '1.0', type: 'snapshot.end', connectionId: 'relay-' + Math.random().toString(36).slice(2), workspaceId: CFG.workspaceId, seq: 3, sentAt: now,
      data: { snapshotId: snapId, partCount: 1, counts, catalogVersion: this.mirror.catalogVersion || 'relay-mirror', coordinateEpoch: this.mirror.coordinateEpoch || 'relay-epoch' },
    });
    // 告诉前端连接就绪
    send({ schemaVersion: '1.0', type: 'server.ready', connectionId: 'relay', workspaceId: CFG.workspaceId, seq: 0, sentAt: now, data: { authExpiresAt: null, heartbeatIntervalSeconds: 20, recommendedRobotIntervalMs: 1000, recovery: 'full_snapshot', limits: {} } });
  }

  // ---------- 上游 ----------
  async getAccessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60000) return this.token.value;
    const res = await fetch(CFG.base + '/openDeveloper/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CFG.oauth),
    });
    const body = await res.json();
    if (body.code !== 0 || !body.data || !body.data.access_token) throw new Error('oauth failed: ' + JSON.stringify(body).slice(0, 200));
    this.token = {
      value: body.data.access_token,
      expiresAt: Date.now() + (Number(body.data.expires_seconds) || 86400) * 1000 - 60000,
    };
    this.log('access token refreshed');
    return this.token.value;
  }

  // 下载版本化 CAD 几何（lines/texts）
  async getResource(resourceId) {
    if (!isConfigured()) throw new Error('中控凭证未配置');
    const token = await this.getAccessToken();
    const res = await fetch(`${CFG.base}/openTwin/v1/workspaces/${CFG.workspaceId}/resources/${resourceId}`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) throw new Error('resource http ' + res.status);
    return res.json();
  }

  async connectUpstream() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.viewers.size === 0) return;
    try {
      const token = await this.getAccessToken();
      const res = await fetch(CFG.base + '/openTwin/v1/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ workspaceId: CFG.workspaceId, connectionType: 'server', origin: null }),
      });
      const body = await res.json();
      if (body.code !== 0 || !body.data || !body.data.ticket) throw new Error('ticket failed: ' + JSON.stringify(body).slice(0, 200));
      const wsUrl = body.data.wsUrl || CFG.wsUrl;
      this.log('connecting upstream', wsUrl);
      const ws = new WebSocket(wsUrl);
      this.upstream = ws;
      this.authenticated = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'authenticate', schemaVersion: '1.0', requestId: 'relay-' + Date.now(), ticket: body.data.ticket }));
      });
      ws.on('message', (data) => this.onUpstreamMessage(data.toString()));
      ws.on('close', () => { this.log('upstream closed'); this.scheduleReconnect(); });
      ws.on('error', (e) => { this.log('upstream error', e.message); });
    } catch (e) {
      this.log('connect failed:', e.message);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.viewers.size === 0) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.log('reconnect in', this.reconnectDelay, 'ms');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectUpstream();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  onUpstreamMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    const type = msg.type;
    if (type === 'heartbeat' && msg.data && msg.data.pingId) {
      try { this.upstream.send(JSON.stringify({ type: 'pong', pingId: msg.data.pingId })); } catch (_) {}
      return;
    }
    if (type === 'auth.error' || type === 'error') {
      this.log('upstream error msg:', JSON.stringify(msg).slice(0, 300));
      try { this.upstream.close(); } catch (_) {}
      return;
    }
    if (type === 'server.ready') { this.authenticated = true; this.reconnectDelay = 1000; }
    if (type === 'snapshot.begin') {
      this.mirror.catalogVersion = msg.data && msg.data.catalogVersion;
      this.mirror.coordinateEpoch = msg.data && msg.data.coordinateEpoch;
      this.lastSnapshotAt = msg.data && msg.data.snapshotAt;
    }
    if (type === 'snapshot.part' && msg.data && msg.data.entities) {
      // 快照分块：整体替换镜像
      const e = msg.data.entities;
      COLLECTIONS.forEach((c) => { this.mirror.entities[c].clear(); });
      COLLECTIONS.forEach((c) => (e[c] || []).forEach((x) => this.mirror.entities[c].set(keyOf(c, x), x)));
      if (FAKE_ROBOT) {
        this.mirror.entities.robots.set(FAKE_ROBOT.robotId, FAKE_ROBOT);
        (e.robots || (e.robots = [])).push(FAKE_ROBOT);
      }
    }
    if (type === 'state.delta' && msg.data) {
      const up = msg.data.upserts || {}, rm = msg.data.removes || {};
      COLLECTIONS.forEach((c) => {
        (up[c] || []).forEach((x) => this.mirror.entities[c].set(keyOf(c, x), x));
        (rm[c] || []).forEach((k) => this.mirror.entities[c].delete(k));
      });
      if (msg.data.catalogVersion) this.mirror.catalogVersion = msg.data.catalogVersion;
      if (msg.data.coordinateEpoch) this.mirror.coordinateEpoch = msg.data.coordinateEpoch;
    }
    // 转发给浏览器观众
    this.broadcast(msg);
  }
}

function attachTwinRelay(server) {
  if (!isConfigured()) {
    console.warn('[twin-relay] 中控凭证未配置：复制 digital-twin/twin-relay.example.js 为 twin-relay.js 并填入凭证后重启服务。');
    return { configured: false, getResource: async () => { throw new Error('中控凭证未配置'); } };
  }
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server, path: '/twin' });
  const relay = new TwinRelay(wss);
  wss.on('connection', (ws) => relay.attachViewer(ws));
  console.log('[twin-relay] attached, ws path /twin, workspace', CFG.workspaceId);
  return relay;
}

module.exports = { attachTwinRelay };
