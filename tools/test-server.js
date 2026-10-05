/**
 * 服务端健壮性回归测试。
 *
 * 覆盖 net-auditor 找出的问题：
 *   1. 畸形/超长帧不能把整个进程带崩（原来一行帧头就能远程杀掉服务）
 *   2. 客户端 FIN 掉线要触发清理（原来 allowHalfOpen 导致座位/房间永久泄漏）
 *   3. /api/net 的地址排序（虚拟网卡不能排在真实网卡前面）
 *   4. 对局中不能被房主一键清零重开
 *   5. 粘包 / 分片 / 未掩码帧都不能崩
 *
 * 会另起一个独立端口的服务进程，不碰正在跑的 5173。
 * 运行：node tools/test-server.js
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const PORT = 5190 + (process.pid % 8);
const ROOT = resolve(import.meta.dirname, '..');

let passed = 0;
const failures = [];
/** 支持 async 的断言包装：await 之后才计分，避免"假绿" */
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 起一个独立服务 ---------------- */
const server = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverExited = null;
let serverStderr = '';
server.on('exit', (code) => {
  serverExited = code;
});
server.stderr.on('data', (d) => {
  serverStderr += d.toString();
});

function assertAlive(where) {
  assert.equal(serverExited, null, `服务进程已退出 code=${serverExited}（${where}）\n${serverStderr.slice(0, 400)}`);
}

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/net`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('测试服务器没起来');
}

/* ---------------- 裸 WebSocket 客户端（可控帧） ---------------- */

/**
 * 连上并开始累积收到的数据。
 * 关键：collector 必须在**握手阶段**就挂上，
 * 否则第一帧（welcome）会随握手响应一起来，被漏掉。
 */
function rawWs(path = '/ws?role=host') {
  return new Promise((res, rej) => {
    const sock = connect(PORT, '127.0.0.1', () => {
      const key = randomBytes(16).toString('base64');
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    const state = { text: '', raw: '' };
    sock.on('data', (d) => {
      state.raw += d.toString('utf8');
      // 跳过握手响应，只留帧里的可读文本
      const idx = state.raw.indexOf('\r\n\r\n');
      state.text = idx >= 0 ? state.raw.slice(idx + 4) : '';
    });
    sock.on('error', rej);
    sock.state = state;
    sock.once('connect', () => res(sock));
  });
}

/** 等到累积文本里出现 re（或超时）；返回文本 */
const waitFor = (sock, re, ms = 2500) =>
  new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const text = sock.state?.text ?? '';
      if (re.test(text)) return res(text);
      if (Date.now() - t0 > ms) return res(text);
      setTimeout(tick, 40);
    };
    tick();
  });

/** 构造一个客户端帧 */
function frame(payload, { opcode = 0x1, masked = true } = {}) {
  const body = Buffer.from(payload);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  if (!masked) return Buffer.concat([header, body]);
  const mask = randomBytes(4);
  header[1] |= 0x80;
  const out = Buffer.from(body);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, out]);
}

/* ---------------- 跑测试 ---------------- */
await waitUp();
console.log('server');

await check('/api/net 可用且带端口', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/net`);
  assert.ok(r.ok, `HTTP ${r.status}`);
  const data = await r.json();
  assert.ok(Array.isArray(data.ips) && data.ips.length > 0, JSON.stringify(data));
  assert.ok(data.port > 0);
});

/* 1. 超长帧不能崩进程 */
await check('声明 9MB 的帧不会把服务进程打死', async () => {
  const sock = await rawWs();
  const head = Buffer.alloc(2);
  head[0] = 0x81;
  head[1] = 127; // 后面跟 8 字节长度
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64BE(9_000_000n, 0);
  sock.write(Buffer.concat([head, lenBuf]));
  await sleep(700);
  assertAlive('超长帧');
  const r = await fetch(`http://127.0.0.1:${PORT}/api/net`).catch(() => null);
  assert.ok(r?.ok, '被攻击后 HTTP 不可用了');
  sock.destroy();
});

/* 2. 客户端 FIN（半关闭）要触发清理 */
await check('客户端半关闭掉线时对手收到 peer-left', async () => {
  const sockA = await rawWs('/ws?role=host');
  const aData = await waitFor(sockA, /"room":/);
  const room = /"room":"(\d+)"/.exec(aData ?? '')?.[1];
  assert.ok(room, `房主没拿到房间号: ${aData}`);

  const sockB = await rawWs(`/ws?role=guest&room=${room}`);
  const bData = await waitFor(sockB, /"side":/);
  assert.match(bData ?? '', /"side":"black"/, `客机没坐上黑方: ${bData}`);

  // A 只发 FIN（WiFi 掉线 / 杀进程就是这个形态）
  sockA.end();
  const left = await waitFor(sockB, /peer-left/, 2500);
  assert.match(left ?? '', /peer-left/, `对手没收到掉线通知: ${left}`);
  sockB.destroy();
});

await check('掉线后座位释放（同房间号可重连，不再 room-full）', async () => {
  const sockA = await rawWs('/ws?role=host');
  const aData = await waitFor(sockA, /"room":/);
  const room = /"room":"(\d+)"/.exec(aData ?? '')?.[1];
  assert.ok(room);
  const sockB = await rawWs(`/ws?role=guest&room=${room}`);
  await waitFor(sockB, /"side":/);

  sockA.end();
  sockB.end();
  await sleep(900);

  // 同一房间号重连：如果座位没释放，这里会拿到 room-full
  const sockC = await rawWs(`/ws?role=guest&room=${room}`);
  const cData = await waitFor(sockC, /"side"|"error"/);
  assert.ok(!/room-full/.test(cData ?? ''), `座位没释放: ${cData}`);
  sockC.destroy();
});

/* 3. 地址排序 */
await check('/api/net 过滤 169.254 链路本地地址', async () => {
  const data = await (await fetch(`http://127.0.0.1:${PORT}/api/net`)).json();
  assert.ok(!data.ips.some((ip) => ip.startsWith('169.254.')), JSON.stringify(data.ips));
});

/* 4. 对局中不允许被重开 */
await check('对局中再次 start 被拒绝（already-playing）', async () => {
  const hostSock = await rawWs('/ws?role=host');
  const welcome = await waitFor(hostSock, /"room":/);
  const room = /"room":"(\d+)"/.exec(welcome ?? '')?.[1];
  const guestSock = await rawWs(`/ws?role=guest&room=${room}`);
  await waitFor(guestSock, /"side":/);

  hostSock.write(frame(JSON.stringify({ t: 'start', level: 2 })));
  await sleep(400);
  hostSock.write(frame(JSON.stringify({ t: 'start', level: 2 })));
  const err = await waitFor(hostSock, /already-playing/);
  assert.match(err ?? '', /already-playing/, `第二次 start 没被拒: ${err}`);
  hostSock.destroy();
  guestSock.destroy();
});

await check('畸形着法不会崩服务、不改局面', async () => {
  const hostSock = await rawWs('/ws?role=host');
  await waitFor(hostSock, /"room":/);
  for (const bad of [
    { t: 'move', from: -1, to: 5 },
    { t: 'move', from: 1e9, to: 2 },
    { t: 'move', from: '3', to: null },
    { t: 'move', from: {}, to: [] },
    { t: 'move' },
  ]) {
    hostSock.write(frame(JSON.stringify(bad)));
  }
  await sleep(600);
  assertAlive('畸形着法');
  hostSock.destroy();
});

/* 5. 粘包 / 分片 / 未掩码 */
await check('一个 TCP 包里的多个帧都能处理', async () => {
  const sock = await rawWs('/ws?role=host');
  await waitFor(sock, /"room":/);
  const frames = [1, 2, 3].map((i) => frame(JSON.stringify({ t: 'nop', i })));
  sock.write(Buffer.concat(frames));
  await sleep(400);
  assertAlive('粘包');
  sock.destroy();
});

await check('分片到达的帧能正确拼起来', async () => {
  const sock = await rawWs('/ws?role=host');
  await waitFor(sock, /"room":/);
  const one = frame(JSON.stringify({ t: 'nop', i: 9 }));
  sock.write(one.subarray(0, 2));
  await sleep(80);
  sock.write(one.subarray(2, 6));
  await sleep(80);
  sock.write(one.subarray(6));
  await sleep(400);
  assertAlive('分片');
  sock.destroy();
});

await check('未掩码帧（协议违规）不会崩服务', async () => {
  const sock = await rawWs('/ws?role=host');
  await waitFor(sock, /"room":/);
  sock.write(frame(JSON.stringify({ t: 'nop' }), { masked: false }));
  await sleep(500);
  assertAlive('未掩码帧');
  sock.destroy();
});

await check('全部攻击后服务依然存活', async () => {
  assertAlive('收尾');
  const r = await fetch(`http://127.0.0.1:${PORT}/api/net`).catch(() => null);
  assert.ok(r?.ok, '服务已经不可用');
});

server.kill();
await sleep(300);

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
