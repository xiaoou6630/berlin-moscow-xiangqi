/**
 * 浏览器里的局域网对战测试：开两个页面，一个建房、一个加入，
 * 真的走一步棋，验证两边的局面会同步。
 *
 * 运行：npm run test:browser:lan
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9350;
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173/';
const OUT = resolve('preview/shots');
const PROFILE = resolve(`.edge-lan-${process.pid}`);

mkdirSync(OUT, { recursive: true });
try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1400,900', '--force-device-scale-factor=1', 'about:blank',
], { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* 等它起来 */ }
    await sleep(250);
  }
  throw new Error('Edge 调试端口未就绪');
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`);
  if (!ok) process.exitCode = 1;
}

/** 开一个页面并返回操作句柄 */
async function newPage(name) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? 'eval 失败'}`);
    return r.result?.value;
  };
  const errors = [];
  await send('Log.enable', {}, sessionId);
  return { name, sessionId, ev, errors, shot: async (file) => {
    const png = await ev(`(() => { const c=document.getElementById('board'); return null; })()`);
    void png;
    const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(resolve(OUT, `${file}.png`), Buffer.from(r.data, 'base64'));
  } };
}

/**
 * 在页面里点某个**真实盘面**索引对应的位置。
 * 用 view.positionOf（已考虑执黑翻转），所以对红黑双方都成立。
 */
const clickIndex = (id) => `(() => {
  const v = window.__kards.state.view, c = document.getElementById('board');
  const rect = c.getBoundingClientRect();
  const p = v.positionOf(${id});
  c.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: rect.left + (p.px / v.layout.width) * rect.width,
    clientY: rect.top + (p.py / v.layout.height) * rect.height, bubbles: true }));
  return true;
})()`;

/** 真实盘面 (file, rank) → 索引 */
const idOf = (file, rank) => rank * 9 + file;

async function main() {
  ws = new WebSocket(await connect());
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
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      for (const p of pages) if (p.sessionId === m.sessionId) p.errors.push(m.params.entry.text);
    }
  });

  console.log('lan-browser');
  const pages = [];

  /* ---- 房主 ---- */
  const host = await newPage('host');
  pages.push(host);
  await send('Page.navigate', { url: BASE }, host.sessionId);
  await sleep(2200);
  await host.ev(`document.querySelector('#modeRow .level[data-mode="host"]').click()`);
  await sleep(300);
  await host.ev(`document.getElementById('startBtn').click()`);
  await sleep(1600);

  const hostView = await host.ev(`(() => ({
    panel: !document.getElementById('hostPanel').hidden,
    room: document.getElementById('roomCode').textContent,
    url: document.getElementById('lanUrl').textContent,
    status: document.getElementById('hostStatus').textContent,
  }))()`);
  check('建房后显示地址与房间号', hostView.panel && /^http:\/\//.test(hostView.url) && /\d/.test(hostView.room), JSON.stringify(hostView));
  // 回归：面板上不允许残留 HTML 里的占位符（那说明点了按钮却什么都没发生）
  check('建房面板没有残留占位符',
    hostView.url !== '—' && hostView.room !== '—' && !/等待握手/.test(hostView.status),
    JSON.stringify(hostView));

  /* 没对手时重复点按钮，必须复用同一间房（否则先等的人会被永远晾着） */
  const reuse = await host.ev(`(async () => {
    const before = window.__kards.state.room;
    document.getElementById('startBtn').click();
    await new Promise((r) => setTimeout(r, 700));
    document.getElementById('startBtn').click();
    await new Promise((r) => setTimeout(r, 700));
    return { before, after: window.__kards.state.room,
             shown: document.getElementById('roomCode').textContent };
  })()`);
  check('重复点"创建房间"复用同一间（不另开新房）',
    reuse.before === reuse.after && reuse.shown === reuse.after,
    JSON.stringify(reuse));

  /* 切到"我建房"就应该自动建房并显示地址，不用先点按钮 */
  const autoHost = await newPage('autohost');
  pages.push(autoHost);
  await send('Page.navigate', { url: BASE }, autoHost.sessionId);
  await sleep(2200);
  const autoView = await autoHost.ev(`(async () => {
    document.querySelector('#modeRow .level[data-mode="host"]').click();
    await new Promise((r) => setTimeout(r, 1800));
    return { url: document.getElementById('lanUrl').textContent,
             room: document.getElementById('roomCode').textContent };
  })()`);
  check('切到"我建房"即自动建房（面板不留占位符）',
    /^http:\/\/.+:5173\/$/.test(autoView.url) && /\d/.test(autoView.room),
    JSON.stringify(autoView));
  await autoHost.ev(`window.__kards.state.link?.close()`);

  /* 即使 /api/net 挂掉也要能显示地址（用当前主机名兜底）。
     单独用一个临时页面做，别把后面要用的房间搅乱。 */
  const fb = await newPage('fallback');
  pages.push(fb);
  await send('Page.navigate', { url: BASE }, fb.sessionId);
  await sleep(2200);
  const fallbackView = await fb.ev(`(async () => {
    const orig = window.fetch;
    window.fetch = (u, o) => (String(u).includes('/api/net') ? Promise.reject(new Error('模拟接口挂了')) : orig(u, o));
    document.querySelector('#modeRow .level[data-mode="host"]').click();
    await new Promise((r) => setTimeout(r, 120));
    document.getElementById('startBtn').click();
    await new Promise((r) => setTimeout(r, 1000));
    window.fetch = orig;
    return { url: document.getElementById('lanUrl').textContent,
             room: document.getElementById('roomCode').textContent };
  })()`);
  check('/api/net 挂掉时仍有地址可显示',
    /^http:\/\/.+:5173\/$/.test(fallbackView.url) && /\d/.test(fallbackView.room),
    JSON.stringify(fallbackView));
  await fb.ev(`window.__kards.state.link?.close()`);

  /* ---- 客机：用 host 的地址加入 ---- */
  const guest = await newPage('guest');
  pages.push(guest);
  await send('Page.navigate', { url: BASE }, guest.sessionId);
  await sleep(2200);
  await guest.ev(`document.querySelector('#modeRow .level[data-mode="guest"]').click()`);
  await sleep(250);
  await guest.ev(`document.getElementById('hostAddr').value = ${JSON.stringify(new URL(BASE).host)}`);
  await guest.ev(`document.getElementById('joinRoom').value = ${JSON.stringify(hostView.room)}`);
  await guest.ev(`document.getElementById('startBtn').click()`);
  await sleep(1800);

  const guestStatus = await guest.ev(`document.getElementById('guestStatus').textContent`);
  check('客机连接成功', /已连接|等待房主/.test(guestStatus), guestStatus);

  const hostStatus = await host.ev(`document.getElementById('hostStatus').textContent`);
  check('房主看到对手已进入', /对手已进入/.test(hostStatus), hostStatus);

  /* ---- 房主开局 ---- */
  await host.ev(`document.getElementById('startBtn').click()`);
  await sleep(2600);

  const both = await host.ev(`(() => ({ started: !!window.__kards.state.game, side: window.__kards.state.linkSide }))()`);
  const guestStarted = await guest.ev(`(() => ({ started: !!window.__kards.state.game, side: window.__kards.state.linkSide }))()`);
  check('房主进入对局且执红', both.started && both.side === 'red', JSON.stringify(both));
  check('客机同步进入对局且执黑', guestStarted.started && guestStarted.side === 'black', JSON.stringify(guestStarted));

  /* ---- 房主走一步，客机应看到 ---- */
  const before = await guest.ev(`window.__kards.state.game.history.length`);
  await host.ev(clickIndex(idOf(0, 6)));
  await sleep(200);
  await host.ev(clickIndex(idOf(0, 5)));
  await sleep(1200);

  const afterGuest = await guest.ev(`(() => ({
    history: window.__kards.state.game.history.length,
    turn: window.__kards.state.game.state.turn,
    soldierAt05: !!window.__kards.state.game.state.board[5 * 9 + 0],
  }))()`);
  check('客机收到房主的着法（局面同步）',
    afterGuest.history > before && afterGuest.turn === 'black' && afterGuest.soldierAt05,
    JSON.stringify({ before, afterGuest }));

  /* ---- 客机走一步，房主应看到 ---- */
  await guest.ev(clickIndex(idOf(0, 3)));
  await sleep(200);
  await guest.ev(clickIndex(idOf(0, 4)));
  await sleep(1200);
  const afterHost = await host.ev(`(() => ({
    history: window.__kards.state.game.history.length,
    turn: window.__kards.state.game.state.turn,
  }))()`);
  check('房主收到客机的着法（双向同步）',
    afterHost.history >= 2 && afterHost.turn === 'red',
    JSON.stringify(afterHost));

  /* ---- 不该能操作对方的子 ---- */
  const illegal = await host.ev(`(() => {
    const k = window.__kards;
    return { turn: k.state.game.state.turn, mySide: k.state.linkSide };
  })()`);
  check('轮次正确（该红方走）', illegal.turn === 'red' && illegal.mySide === 'red', JSON.stringify(illegal));

  await host.shot('lan-host');
  await guest.shot('lan-guest');

  const errs = [...host.errors, ...guest.errors].filter((e) => !/favicon|Failed to load resource/i.test(e));
  check('两个页面都没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
}

main()
  .catch((err) => {
    console.error('运行失败:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { ws?.close(); } catch { /* ignore */ }
    edge.kill();
    setTimeout(() => {
      try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
      process.exit(process.exitCode ?? 0);
    }, 600);
  });
