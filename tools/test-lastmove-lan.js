/**
 * 「上一手」标记在联机翻转视角下画在哪（干净版）。
 *
 * 用户反馈（选 C）：执黑（德国）时，对手（苏联）走棋的"上一手"标记
 * 画到了镜像位置。
 *
 * 之前的测试用 ?auto=1 单人模式，我走完引擎立刻应招，
 * 标记被引擎那一步覆盖，读数对不上。这里改成真联机：
 * 客机执黑只看不动，由房主（红）走，然后核对客机侧标记画在哪。
 *
 * 运行：node tools/test-lastmove-lan.js
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 12800 + ((process.pid ?? 0) % 150);
const PROFILE = resolve(import.meta.dirname, '..', `.edge-lmlan-${process.pid}`);
const BASE = 'http://127.0.0.1:5173/';
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

console.log('lastmove-lan');

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

  async function newPage(label) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(`${label}: ${r.exceptionDetails.exception?.description ?? 'eval 失败'}`);
      return r.result?.value;
    };
    return { label, sessionId, ev };
  }

  const host = await newPage('host');
  const guest = await newPage('guest');

  await send('Page.navigate', { url: BASE }, host.sessionId);
  await sleep(2500);
  await host.ev(`document.querySelector('#modeRow .level[data-mode="host"]').click()`);
  await sleep(1800);
  const room = await host.ev(`document.getElementById('roomCode').textContent`);
  const url = await host.ev(`document.getElementById('lanUrl').textContent`);

  await send('Page.navigate', { url: BASE }, guest.sessionId);
  await sleep(2500);
  await guest.ev(`document.querySelector('#modeRow .level[data-mode="guest"]').click()`);
  await sleep(300);
  await guest.ev(`(() => {
    document.getElementById('hostAddr').value = ${JSON.stringify(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))};
    document.getElementById('joinRoom').value = ${JSON.stringify(room)};
  })()`);
  await guest.ev(`document.getElementById('startBtn').click()`);
  await sleep(2500);
  await host.ev(`document.getElementById('startBtn').click()`);
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    if (await guest.ev(`!!(window.__kards && window.__kards.state.game)`)) break;
  }
  await sleep(1200);

  const sides = await guest.ev(`(() => {
    const k = window.__kards;
    return { human: k.state.humanSide, flipped: k.state.view.isFlipped() };
  })()`);
  await check('客机执黑并翻转', () => {
    if (sides.human !== 'black' || !sides.flipped) throw new Error(JSON.stringify(sides));
  });

  // 客机侧挂钩：记录 markLastMove 收到什么
  await guest.ev(`(() => {
    const v = window.__kards.state.view;
    window.__lmLog = [];
    const orig = v.markLastMove.bind(v);
    v.markLastMove = function (from, to, now) {
      window.__lmLog.push({ from, to, flip: v.isFlipped() });
      return orig(from, to, now);
    };
    return true;
  })()`);

  // 房主（红）走一步：挑一个位移明显的（长距离），方便区分起终点
  const move = await host.ev(`(async () => {
    const k = window.__kards, v = k.state.view;
    const mod = await import('/src/engine/rules.js');
    const st = k.state.game.state;
    const ms = mod.legalMoves(st, st.turn).filter((x) => !st.board[x.to]);
    const m = ms.find((x) => Math.abs(x.to - x.from) >= 9) || ms[0];
    const c = document.getElementById('board');
    const r = c.getBoundingClientRect();
    const fire = (idx) => { const p = v.positionOf(idx);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + (p.px / v.layout.width) * r.width,
        clientY: r.top + (p.py / v.layout.height) * r.height, bubbles: true, pointerType: 'mouse' })); };
    fire(m.from); await new Promise((z) => setTimeout(z, 150)); fire(m.to);
    return m;
  })()`);

  await sleep(2000);

  const info = await guest.ev(`(() => {
    const k = window.__kards, v = k.state.view;
    return {
      lmLog: window.__lmLog,
      viewLastMove: v.lastMove,
      gameLastMove: k.state.game.lastMove,
      history: k.state.game.history.map((h) => h.from + '>' + h.to),
      flip: v.isFlipped(),
    };
  })()`);

  console.log('      房主走:', move.from, '->', move.to, '（模型坐标）');
  console.log('      客机 lmLog:', JSON.stringify(info.lmLog));
  console.log('      客机 view.lastMove:', JSON.stringify(info.viewLastMove));
  console.log('      客机 history:', JSON.stringify(info.history));

  const wantFrom = 89 - move.from;
  const wantTo = 89 - move.to;

  await check('客机把对手这步记成了"翻转后的显示坐标"', () => {
    const lm = info.viewLastMove;
    if (!lm) throw new Error('客机侧没有上一手标记');
    if (lm.from !== wantFrom || lm.to !== wantTo) {
      throw new Error(
        `标记记录 ${lm.from}->${lm.to}，应为 ${wantFrom}->${wantTo}`
        + `（模型 ${move.from}->${move.to}）`,
      );
    }
  });

  await check('标记不是镜像的（未翻转坐标）', () => {
    const lm = info.viewLastMove;
    if (lm.from === move.from && lm.to === move.to) {
      throw new Error(`标记记成了未翻转的 ${move.from}->${move.to}，即镜像位置`);
    }
  });

  // 再核对真正画出来的像素位置
  const drawn = await guest.ev(`(() => {
    const v = window.__kards.state.view;
    const calls = [];
    const orig = v.positionOf.bind(v);
    const rec = { on: false };
    v.positionOf = function (id) { if (rec.on) calls.push(id); return orig(id); };
    const origDraw = v.drawLastMove.bind(v);
    v.drawLastMove = function (now) { rec.on = true; try { return origDraw(now); } finally { rec.on = false; } };
    v.render(performance.now());
    v.drawLastMove = origDraw;
    v.positionOf = orig;
    const lm = v.lastMove;
    const p = (id) => { const pt = orig(id); return [ +pt.px.toFixed(1), +pt.py.toFixed(1) ]; };
    return { calls, fromPx: p(lm.from), toPx: p(lm.to) };
  })()`);

  await check('画框用的位置等于"翻转后"的显示格像素', () => {
    if (drawn.calls.length < 2) throw new Error(`只查询了 ${drawn.calls.length} 次位置`);
    const [gotFrom, gotTo] = drawn.calls;
    if (gotFrom !== wantFrom || gotTo !== wantTo) {
      throw new Error(`画框查询 ${gotFrom}->${gotTo}，应为 ${wantFrom}->${wantTo}`);
    }
  });

  console.log('      画框像素: 起点', JSON.stringify(drawn.fromPx), '终点', JSON.stringify(drawn.toPx));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  edge.kill();
  await sleep(300);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
