/**
 * 静止不重绘的验证。
 *
 * 主循环原来每帧全量重绘 30 多张卡（60fps 白转风扇）。
 * 加了 needsRender 判断后：完全静止应当几乎不画，但任何状态变化必须立刻重新画。
 *
 * 运行：node tools/test-idle.js（需要 Edge 与已在跑的服务器）
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 11300 + (process.pid % 100);
const PROFILE = resolve(import.meta.dirname, '..', `.edge-idle-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();
const send = (method, params = {}, sessionId) => {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};

console.log('idle');

try {
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* 等 */ }
    await sleep(200);
  }
  if (!wsUrl) throw new Error('Edge 没起来');
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
    return r.result?.value;
  };

  await send('Page.navigate', { url: 'http://127.0.0.1:5173/?faction=soviet&level=1&auto=1' }, S);
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    if (await ev(`!!(window.__kards && window.__kards.state.game)`)) break;
  }
  // 等所有出场 / 上一手动画彻底结束
  await sleep(7000);

  await ev(`(() => {
    window.__draws = 0;
    const cv = document.getElementById('board');
    const ctx = cv.getContext('2d');
    const od = ctx.drawImage.bind(ctx);
    ctx.drawImage = function (...a) { window.__draws++; return od(...a); };
    return true;
  })()`);

  /** 数接下来 n 帧里画了多少次 */
  const countFrames = (n) => ev(`(async () => {
    const start = window.__draws;
    for (let i = 0; i < ${n}; i++) await new Promise((z) => requestAnimationFrame(z));
    return window.__draws - start;
  })()`);

  const idle = await countFrames(60);
  await check('完全静止的 60 帧里基本不重绘（省电）', () => {
    // 允许极少量的边界重绘；原来每帧都要画 30+ 张
    if (idle > 40) throw new Error(`60 帧画了 ${idle} 次，说明还在一直全量重绘`);
  });

  // 选中一个棋子 → 高亮要呼吸闪烁，必须持续重绘
  await ev(`(() => {
    const k = window.__kards, v = k.state.view;
    const b = k.state.game.state.board;
    let id = -1;
    for (let i = 0; i < 90; i++) if (b[i] && b[i].side === 'red') { id = i; break; }
    v.selected = id;
    v.targets = new Set([id + 9 < 90 ? id + 9 : id]);
  })()`);
  const selected = await countFrames(30);
  await check('选中棋子后有高亮呼吸，持续重绘', () => {
    if (selected < 100) throw new Error(`30 帧只画了 ${selected} 次，高亮动画可能卡住了`);
  });

  // 走一步 → 必须立刻反映到画面
  const moved = await ev(`(async () => {
    const k = window.__kards;
    const mod = await import('/src/engine/rules.js');
    const ms = mod.legalMoves(k.state.game.state, k.state.game.state.turn);
    const m = ms[0];
    const v = k.state.view;
    v.selected = null; v.targets = new Set();
    // 走子走的是 applyAndAdvance 那条路：直接改盘面 + refreshView
    const board = k.state.game.state.board;
    const piece = board[m.from];
    board[m.to] = piece; board[m.from] = null;
    k.state.game.history.push({ from: m.from, to: m.to, mover: piece, captured: null });
    k.state.game.lastMove = { from: m.from, to: m.to };
    k.state.game.state.turn = k.state.game.state.turn === 'red' ? 'black' : 'red';
    window.__afterMove = { board: board.map((p) => (p ? p.type : '.')).join(''), turn: k.state.game.state.turn };
    k.refreshView({ animate: true });
    const start = window.__draws;
    for (let i = 0; i < 20; i++) await new Promise((z) => requestAnimationFrame(z));
    return { drew: window.__draws - start, src: m.from, dst: m.to };
  })()`);
  await check('走子后画面立刻重绘（不会被"静止"卡住）', () => {
    if (moved.drew < 20) throw new Error(`走子后 20 帧只画了 ${moved.drew} 次`);
  });

  // 等动画彻底做完：轮询 needsRender，直到它稳定为 false（别用固定 sleep 猜）
  const settle = await ev(`(async () => {
    const v = window.__kards.state.view;
    for (let i = 0; i < 120; i++) {
      if (!v.needsRender(performance.now())) return { ok: true, waitedMs: i * 100 };
      await new Promise((z) => setTimeout(z, 100));
    }
    return { ok: false };
  })()`);
  await check('动画结束后画面能进入静止状态', () => {
    if (!settle.ok) throw new Error('等了 12 秒仍未静止，说明有动画永远停不下来');
  });

  await ev(`window.__draws = 0`);
  const idleAgain = await countFrames(60);
  await check('动画结束后重新回到静止不重绘', () => {
    if (idleAgain > 40) throw new Error(`60 帧画了 ${idleAgain} 次`);
  });

  console.log(
    `      （静止 ${idle} 次 / 选中 ${selected} 次 / 走子 ${moved.drew} 次`
    + ` / 再静止 ${idleAgain} 次，等待 ${settle.waitedMs ?? '?'}ms）`,
  );
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  edge.kill();
  await sleep(300);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
