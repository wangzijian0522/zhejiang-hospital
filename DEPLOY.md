# 数字孪生项目部署手册

## 1. 环境概览

| 项 | 值 |
| --- | --- |
| 生产服务器 | 阿里云 ECS `121.41.198.247` |
| 服务目录 | `/opt/zhejiang-hospital`（静态资源根目录） |
| 访问地址 | `http://121.41.198.247:8080/digital-twin/` |
| 进程管理 | systemd 服务 `zhejiang-hospital.service`（Restart=always） |
| 启动入口 | `node digital-twin/server.js`（端口 `PORT` 环境变量，默认 8080） |

服务器通过 SSH 登录；连接配置保存在部署机本地脚本（`C:/Users/34868/deploy-tmp/`），**不要写入仓库或本手册**。

## 2. 本地开发

```bash
cd digital-twin
node server.js          # 默认 8080，可用 PORT=8099 换端口
```

访问 `http://127.0.0.1:8080/digital-twin/`。

注意：服务进程**不会热重载代码**。改了 `server.js` 必须重启进程；改了 `index.html` 等静态文件刷新页面即可。本机 8080 常驻旧进程时，先确认进程归属再决定是否重启，别误杀。

## 3. 中控凭证（机器人实时数据）

`/twin`（实时数据）和 `/twin-resource`（CAD 平面图）依赖中控 openTwin 凭证，三种接入方式任选其一：

1. 把 `digital-twin/twin-relay.credentials.json`（由持有真实凭证的成员**私下分发**，已 gitignore）放到 `digital-twin/` 目录；
2. 设置环境变量 `TWIN_CLIENT_ID / TWIN_CLIENT_SECRET / TWIN_ACCESS_KEY_ID / TWIN_ACCESS_KEY_SECRET`（可选 `TWIN_WORKSPACE_ID`）；
3. 复制 `twin-relay.example.js` 为 `twin-relay.js` 并填入凭证。

优先级：本地凭证文件 > 环境变量 > 占位符。

**安全约定**：`twin-relay.js`、`twin-relay.credentials.json` 及所有 dotfiles 均被 `.gitignore` 排除，`server.js` 也会对这两个路径返回 404。仓库是公开的，任何真实凭证一律不得提交；泄漏后应立刻联系中控更换。

## 4. 发布流程（建议按此顺序）

### 4.1 准备与比对

```bash
git pull --no-edit            # 先同步同事改动
git status                    # 确认要发布的内容
node --check digital-twin/server.js   # server.js 语法
# index.html 内联模块语法：
node --input-type=module -e "import fs from 'node:fs';import{spawnSync}from'node:child_process';const h=fs.readFileSync('digital-twin/index.html','utf8');const r=spawnSync(process.execPath,['--input-type=module','--check'],{input:h.match(/<script type=\"module\">([\\s\\S]*?)<\\/script>/)[1],encoding:'utf8'});if(r.status)throw new Error(r.stderr);console.log('OK')"
```

### 4.2 逐文件哈希对比（只传有变化的文件）

本地：`sha256sum 文件`；线上：SSH 后 `sha256sum /opt/zhejiang-hospital/...`。

常见待发布路径映射：

| 本地 | 线上 |
| --- | --- |
| `digital-twin/index.html` | `/opt/zhejiang-hospital/digital-twin/index.html` |
| `digital-twin/server.js` | `/opt/zhejiang-hospital/digital-twin/server.js` |
| `digital-twin/data/*.js` | `/opt/zhejiang-hospital/digital-twin/data/*.js` |
| `models/models/*.glb` | `/opt/zhejiang-hospital/models/models/*.glb` |

### 4.3 备份 → 上传 → 原子替换（逐文件）

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
cp -p /opt/zhejiang-hospital/digital-twin/index.html /opt/zhejiang-hospital-index-${TS}.bak
# SFTP 上传到临时名
/opt/zhejiang-hospital/digital-twin/index.html.${TS}.tmp
# 校验临时文件哈希与本地一致后替换
mv -T /opt/zhejiang-hospital/digital-twin/index.html.${TS}.tmp \
      /opt/zhejiang-hospital/digital-twin/index.html
```

备份统一放在 `/opt/` 下（Web 根目录之外），命名 `zhejiang-hospital-<文件名>-<时间戳>.bak`。回滚即把 `.bak` 复制回去。

### 4.4 重启服务（仅 server.js 变化时需要）

```bash
sudo systemctl restart zhejiang-hospital.service
systemctl show zhejiang-hospital.service -p MainPID -p ActiveState   # 确认新 PID、active
```

静态文件（index.html / data / 模型）**无需重启**，替换后立即生效。

### 4.5 公网验证

```bash
curl -I http://121.41.198.247:8080/digital-twin/          # 200
curl http://121.41.198.247:8080/digital-twin/ | sha256sum  # 与本地一致
curl -o /dev/null -w '%{http_code}' http://121.41.198.247:8080/digital-twin/twin-relay.js   # 应 404
```

页面可开浏览器验证：总览视角、自动巡航按钮、右侧机器人实时状态列表、2/6 号楼透视与返回。

## 5. 常用运维命令

```bash
systemctl status zhejiang-hospital.service        # 状态
journalctl -u zhejiang-hospital -n 50 --no-pager  # 日志
sudo systemctl restart zhejiang-hospital.service  # 重启
```

天地图瓦片 key 可用环境变量 `TDT_TK` 覆盖（server.js 内置浏览器端 key，仅作服务端代取）。

## 6. 注意事项

- **不要**提交/上传：中控凭证、`_iface_*` 接口文档、`接口说明/`、`*.rar`、日志与临时文件（见 `.gitignore`）。
- GitHub 单文件上限 100MB（如 `医院建筑平面.rar` 107MB 即无法上传，由 `*.rar` 规则忽略）。
- 每次发布前先 `git pull`；发布后如仓库有未推送提交，按需 commit/push。
- 数据库、中继（twin-relay.js）等改动需谨慎：重启会断开当前 `/twin` 观众连接，页面会自动重连。
