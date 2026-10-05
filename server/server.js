/**
 * 静态文件服务器 + 局域网对战 WebSocket 房间。
 * 零依赖：直接跑 `npm start` 即可。
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acceptUpgrade } from './ws.js';
import { RoomStore } from './rooms.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

const PUBLIC_DIR = join(ROOT, 'public');
const SRC_DIR = join(ROOT, 'src');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 把 URL 路径映射到磁盘路径，并确保没有越出允许的根目录。
 *
 * 完全镜像 GitHub Pages 的目录结构：
 *   Pages 上站点根是 /<repo>/，入口页在仓库根，靠 <base href="./public/"> 指到 public/。
 *   所以浏览器请求的实际是：
 *     /<repo>/public/styles.css      → public/styles.css
 *     /<repo>/public/src/main.js     → public/src/main.js   （页面脚本）
 *     /<repo>/src/engine/rules.js    → src/engine/rules.js  （共享引擎）
 *
 * 本地就照这个来：public/ 优先，/src/ 取不到再回落到仓库根的 src/。
 */
function resolveTarget(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(clean).replace(/^([/\\])+/, '').replace(/^public[/\\]/, '');

  const candidates = [
    { base: PUBLIC_DIR, sub: rel === '' ? 'index.html' : rel },
    // /src/... 先看 public/src（页面脚本），取不到再看根 src（引擎/几何）
    rel.startsWith('src/') || rel.startsWith(`src${sep}`) ? { base: ROOT, sub: rel } : null,
  ].filter(Boolean);

  for (const { base, sub } of candidates) {
    const full = resolve(base, sub);
    if (full !== base && !full.startsWith(base + sep)) continue;
    try {
      const st = statSync(full);
      if (st.isFile()) return { full, size: st.size };
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  return null;
}

export function createApp() {
  const store = new RoomStore();

  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    // 局域网信息：给前端显示"让朋友连这个地址"
    if (req.url === '/api/net' || req.url?.startsWith('/api/net?')) {
      const body = JSON.stringify({ ips: lanAddresses(), port: server.address()?.port ?? null });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    const target = resolveTarget(req.url ?? '/');
    if (!target) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const type = MIME[extname(target.full).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': target.size,
      // 开发中改动频繁，禁止任何缓存（no-cache 仍可能命中磁盘缓存，用 no-store）
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache',
      expires: '0',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(target.full).pipe(res);
  });

  /* ---------------- 局域网对战 ---------------- */

  server.on('upgrade', (req, socket) => {
    if (!req.url?.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const conn = acceptUpgrade(req, socket);
    if (!conn) return;

    const params = new URL(req.url, 'http://local').searchParams;
    const role = params.get('role') === 'guest' ? 'guest' : 'host';
    const roomId = params.get('room');
    const room = role === 'host' ? store.create() : store.join(roomId);

    if (!room) {
      // 房间号打错时明确报错，而不是偷偷开一间没人的幽灵房
      conn.send(JSON.stringify({ t: 'error', error: 'room-not-found', room: roomId ?? null }));
      conn.close(1008, 'room-not-found');
      return;
    }

    const side = room.seat(conn);
    if (!side) {
      conn.send(JSON.stringify({ t: 'error', error: 'room-full' }));
      conn.close();
      return;
    }

    conn.send(JSON.stringify({ t: 'welcome', role, side, room: room.id }));

    conn.onmessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === 'start' && role === 'host') {
        // 对局中不允许重开；重赛走 rematch
        if (room.phase === 'playing') {
          conn.send(JSON.stringify({ t: 'error', error: 'already-playing' }));
        } else {
          room.start(msg.level);
        }
      } else if (msg.t === 'move') {
        const r = room.move(conn, msg.from, msg.to);
        if (!r.ok) conn.send(JSON.stringify({ t: 'reject', error: r.error, from: msg.from, to: msg.to }));
      } else if (msg.t === 'rematch' && role === 'host') {
        room.start(msg.level ?? room.level, true);
      }
    };

    conn.onclose = () => {
      room.leave(conn);
      room.broadcast({ t: 'peer-left', side });
      store.reap();
    };

    // 对手进来就通知双方可以开局了
    room.broadcast({ t: 'room', room: room.id, full: room.full, phase: room.phase });
  });

  return server;
}

/**
 * 取本机局域网 IPv4。
 *
 * 只过滤 virtual/internal 是不够的：装了 VMware / VirtualBox / Hyper-V 的机器上，
 * 虚拟网卡地址（如 192.168.x.1）会排在真实 WLAN 前面，房主把 ips[0] 发出去
 * 朋友必然连不上。这里把虚拟网卡降权，并剔除 169.254 链路本地地址。
 */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue; // APIPA，连不通
      out.push({ name, address: ni.address, score: adapterScore(name, ni.address) });
    }
  }
  out.sort((a, b) => a.score - b.score);
  return out.map((x) => x.address);
}

/** 越小越可能是真正在用的网卡 */
function adapterScore(name, address) {
  const n = String(name).toLowerCase();
  let score = 50;
  // 明显是虚拟网卡
  if (/vmware|virtualbox|vethernet|hyper-v|loopback|docker|wsl|tailscale|zerotier|radmin|tap|tun|npcap/.test(n)) {
    score += 100;
  }
  // 常见真实网卡关键字
  if (/wi-?fi|wlan|wireless|以太网|ethernet|realtek|intel|qualcomm|broadcom|mediatek/.test(n)) {
    score -= 60;
  }
  // 家用网段加分（最可能是路由器发的地址）
  if (/^192\.168\./.test(address)) score -= 20;
  else if (/^10\./.test(address)) score -= 15;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score -= 10;
  return score;
}

export function start({ port = 5173, host = '0.0.0.0' } = {}) {
  const server = createApp();
  server.listen(port, host, () => {
    const addr = server.address();
    const ips = lanAddresses();
    console.log(`棋盘已启动 → http://127.0.0.1:${addr.port}/`);
    if (ips.length) {
      console.log('局域网（同一 WiFi 下，另一台设备打开这个地址即可联机）：');
      for (const ip of ips) console.log(`  http://${ip}:${addr.port}/`);
    }
  });
  return server;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const port = Number(process.env.PORT ?? 5173);
  const host = process.env.HOST ?? '0.0.0.0';
  start({ port, host });
}
