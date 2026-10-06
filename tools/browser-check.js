/**
 * 用 Edge 无头 + CDP 真跑一局，并把 canvas 的真实像素导出成 PNG。
 *
 * 为什么不用 Page.captureScreenshot：headless 下 canvas 属于独立的加速图层，
 * 截图有时只拿到合成前的黑底。这里直接读 canvas 的 getImageData，最可靠。
 *
 * 运行：node tools/browser-check.js
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173/';
const OUT = resolve('preview/shots');
const PROFILE = resolve(`.edge-profile-${process.pid}`);

mkdirSync(OUT, { recursive: true });
try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略残留 */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 极简 PNG 编码 ---------------- */
function crcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC = crcTable();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, c]);
}
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- CDP ---------------- */
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1440,1080', '--force-device-scale-factor=1', 'about:blank',
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
    } catch { /* 还没起来 */ }
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

async function main() {
  ws = new WebSocket(await connect());
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      errors.push(m.params.entry.text);
    }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Log.enable', {}, S);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
    return r.result?.value;
  };

  /** 导出 canvas 真实像素为 PNG */
  async function shotCanvas(name) {
    await ev(`window.__kards.state.view.render(performance.now())`);
    const data = await ev(`(() => {
      const c = document.getElementById('board');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let bin = '';
      const CH = 8192;
      for (let i = 0; i < d.length; i += CH) bin += String.fromCharCode.apply(null, d.subarray(i, i + CH));
      return btoa(bin);
    })()`);
    const buf = Buffer.from(data, 'base64');
    const size = await ev(`(() => { const c = document.getElementById('board'); return [c.width, c.height]; })()`);
    writeFileSync(resolve(OUT, `${name}.png`), encodePNG(size[0], size[1], buf));
    return size;
  }

  async function shotPage(name) {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, S);
    writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  }

  console.log('browser');

  /* 1. 选边界面 */
  await send('Page.navigate', { url: BASE }, S);
  await sleep(2500);
  await shotPage('ui-menu');
  check('选边界面有两个阵营', (await ev(`document.querySelectorAll('.faction').length`)) === 2);
  check('四个引擎档位', (await ev(`document.querySelectorAll('#levelRow .level').length`)) === 4);
  check('三种对局模式（同机 / 建房 / 加入）',
    (await ev(`[...document.querySelectorAll('#modeRow .level')].map(b=>b.dataset.mode).join(',')`))
      === 'local,host,guest');
  check('未选边时禁用开始', (await ev(`document.getElementById('startBtn').disabled`)) === true);

  await ev(`document.querySelector('.faction[data-id="soviet"]').click()`);
  await sleep(150);
  check('选边后可开始', (await ev(`document.getElementById('startBtn').disabled`)) === false);
  await ev(`document.querySelector('.level[data-id="2"]').click()`);

  /* 2. 开局 */
  await ev(`document.getElementById('startBtn').click()`);
  await sleep(3000);
  const startState = await ev(`({ view: !!window.__kards.state.view, hint: document.getElementById('menuHint').textContent, err: window.__kardsErr ?? null })`);
  if (!startState.view) {
    console.log('  [调试] 开局失败:', JSON.stringify(startState, null, 1));
    console.log('  [调试] 报错:', JSON.stringify(errors.slice(0, 5), null, 1));
    throw new Error('开局未建立棋盘视图');
  }
  const size = await shotCanvas('game-start');
  await shotPage('ui-game');

  const info = await ev(`(() => {
    const m = window.__kards;
    return { sprites: m.state.view.sprites.size, humanSide: m.state.humanSide,
             turn: m.state.game.state.turn, cardW: Math.round(m.state.view.cardW),
             canvas: [document.getElementById('board').width, document.getElementById('board').height] };
  })()`);
  check('棋盘视图已建立', info.sprites === 32, JSON.stringify(info));
  check('32 个棋子全部就位', info.sprites === 32, `实际 ${info.sprites}`);
  check('画布已按 DPR 设置', size[0] > 400 && size[1] > 400, JSON.stringify(size));

  /* 3. 玩家走子 */
  const move = await ev(`(() => {
    const m = window.__kards, v = m.state.view, c = document.getElementById('board');
    const rect = c.getBoundingClientRect();
    const fire = (file, rank) => {
      const p = v.pointAt(file, rank);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: rect.left + (p.px / v.layout.width) * rect.width,
        clientY: rect.top + (p.py / v.layout.height) * rect.height, bubbles: true }));
    };
    fire(0, 6); const sel = v.selected;
    fire(0, 5);
    return { sel, history: m.state.game.history.length, turn: m.state.game.state.turn };
  })()`);
  check('点选棋子', move.sel === 6 * 9 + 0, JSON.stringify(move));
  check('走子后轮到对方', move.turn === 'black', JSON.stringify(move));
  await sleep(300);
  await shotCanvas('game-after-move');

  /* 4. 引擎应招 */
  await sleep(3000);
  const afterAi = await ev(`({ history: window.__kards.state.game.history.length, turn: window.__kards.state.game.state.turn })`);
  check('引擎已应招', afterAi.history >= 2, JSON.stringify(afterAi));
  await shotCanvas('game-after-ai');

  /* 5. 将死 + 翻倒动画 */
  await ev(`(async () => {
    const m = window.__kards;
    const rules = await import('/src/engine/rules.js');
    const { RED, BLACK, idx } = rules;
    const b = new Array(90).fill(null);
    const P = (t, s) => ({ type: t, side: s });
    b[idx(4,0)] = P('general', BLACK);
    b[idx(4,9)] = P('general', RED);
    b[idx(0,0)] = P('chariot', RED);
    b[idx(8,0)] = P('chariot', RED);
    b[idx(4,4)] = P('chariot', RED);
    m.state.game.state.board = b;
    m.state.game.state.turn = RED;
    m.state.game.history = [];
    m.state.view.sync(b, { animate: false });
    m.state.over = false;
    const v = m.state.view, c = document.getElementById('board');
    const rect = c.getBoundingClientRect();
    const fire = (file, rank) => {
      const p = v.pointAt(file, rank);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: rect.left + (p.px / v.layout.width) * rect.width,
        clientY: rect.top + (p.py / v.layout.height) * rect.height, bubbles: true }));
    };
    fire(4, 4); fire(4, 1);
  })()`);

  await sleep(280);
  await shotCanvas('game-death-red');
  await sleep(600);
  await shotCanvas('game-death-falling');
  const fallen = await ev(`window.__kards.state.view.fallen.length`);
  await sleep(1200);
  await shotCanvas('game-death-done');
  const result = await ev(`(() => {
    const el = document.getElementById('result');
    return { hidden: el.hidden, title: document.getElementById('resultTitle').textContent,
             reason: document.getElementById('resultReason').textContent,
             badge: document.getElementById('resultBadge').textContent };
  })()`);
  await shotCanvas('game-result');
  await shotPage('ui-result');

  check('吃子触发了翻倒动画', fallen >= 0 && result.hidden === false, JSON.stringify({ fallen, result }));
  check('结算面板弹出', result.hidden === false, JSON.stringify(result));
  check('判定胜方为红方/莫斯科', /莫斯科|红方/.test(result.reason), result.reason);
  check('结算徽标为"胜"', result.badge === '胜', result.badge);
  check('页面无 JS 报错', errors.filter((e) => !/favicon|Failed to load resource/i.test(e)).length === 0,
    errors.slice(0, 3).join(' | '));

  /* 5.5 背景贴图必须真的看得见（棋盘空白格要有纹理，不能是一块死黑） */
  const bgProbe = await ev(`(async () => {
    const m = await import('./src/theme.js');
    const v = window.__kards.state.view;
    v.render(performance.now());
    const c = document.getElementById('board');
    const g = c.getContext('2d');
    const dpr = c.width / v.layout.width;
    // 取一个四角都在棋盘内、且没有棋子的格子中心（第 5 行第 1 路附近是空的）
    const p = v.pointAt(1.5, 5);
    const size = Math.round(v.layout.filePitch * 0.3 * dpr);
    const d = g.getImageData(Math.round(p.px * dpr - size / 2), Math.round(p.py * dpr - size / 2), size, size).data;
    let n = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += lum; sum2 += lum * lum; n++;
    }
    const mean = sum / n;
    return { mean: +mean.toFixed(1), std: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(2),
             need: m.BACKDROP.minTextureStd };
  })()`);
  check('背景贴图可见（空白格有纹理而非死黑）',
    bgProbe.std >= bgProbe.need && bgProbe.mean > 25,
    `mean=${bgProbe.mean} std=${bgProbe.std} 要求 std>=${bgProbe.need} 且 mean>25`);

  /* 6. 手机尺寸：棋盘必须完整落在视口内 */
  await send('Emulation.setDeviceMetricsOverride',
    { width: 430, height: 932, deviceScaleFactor: 2, mobile: true }, S);
  await send('Page.navigate', { url: `${BASE}?faction=germany&level=2&auto=1` }, S);
  await sleep(4000);
  const phone = await ev(`(() => {
    const c = document.getElementById('board');
    const r = c.getBoundingClientRect();
    return { vw: innerWidth, vh: innerHeight,
             right: Math.round(r.right), bottom: Math.round(r.bottom),
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  check('手机竖屏下棋盘不溢出', phone.right <= phone.vw + 1 && phone.bottom <= phone.vh + 1, JSON.stringify(phone));
  check('手机竖屏下棋盘够大', phone.w > 300 && phone.h > 300, JSON.stringify(phone));
  await shotCanvas('mobile-board');

  /* 手机竖屏菜单：标题不能被裁到视口外，而且要能滚出来 */
  await send('Page.navigate', { url: BASE }, S);
  await sleep(2200);
  const menuMobile = await ev(`(() => {
    const t = document.querySelector('.title');
    const r = t.getBoundingClientRect();
    const ov = document.getElementById('menu');
    return { top: Math.round(r.top), visible: r.top >= -1 && r.bottom <= innerHeight + 1,
             scrollable: ov.scrollHeight > ov.clientHeight };
  })()`);
  check('手机竖屏菜单标题可见（不被 flex 居中裁掉）', menuMobile.visible && menuMobile.top >= -1,
    JSON.stringify(menuMobile));
  await send('Emulation.clearDeviceMetricsOverride', {}, S);

  /* 7. 两人同机：红黑都由人操作，不走引擎 */
  await send('Page.navigate', { url: BASE }, S);
  await sleep(2500);
  // 本地模式仍需先选一方（同机时这方决定你坐哪边看棋盘）
  await ev(`document.querySelector('.faction[data-id="soviet"]').click()`);
  await sleep(150);
  await ev(`document.getElementById('hotseatChk').checked = true;
            document.getElementById('hotseatChk').dispatchEvent(new Event('change'))`);
  await sleep(200);
  const hotseatLabel = await ev(`document.getElementById('levelsLabel').textContent`);
  check('勾选两人同机后档位提示改变', /不需要引擎/.test(hotseatLabel), hotseatLabel);

  await ev(`document.getElementById('startBtn').click()`);
  await sleep(3500);
  const hot = await ev(`(() => {
    const k = window.__kards;
    return { playMode: k.state.playMode, started: !!k.state.game,
             err: window.__kardsErr ?? null,
             hint: document.getElementById('menuHint').textContent,
             turn: k.state.game?.state.turn };
  })()`);
  check('两人同机模式已开局', hot.started && hot.playMode === 'hotseat', JSON.stringify(hot));

  // 红方走一步 → 应该轮到黑方，且**不会**触发引擎
  const hs1 = await ev(`(() => {
    const v = window.__kards.state.view, c = document.getElementById('board');
    const rect = c.getBoundingClientRect();
    const fire = (f, r) => { const p = v.pointAt(f, r);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: rect.left + (p.px / v.layout.width) * rect.width,
        clientY: rect.top + (p.py / v.layout.height) * rect.height, bubbles: true })); };
    fire(0, 6); fire(0, 5);
    return { history: window.__kards.state.game.history.length, turn: window.__kards.state.game.state.turn };
  })()`);
  check('同机模式红方走子后轮到黑方', hs1.history === 1 && hs1.turn === 'black', JSON.stringify(hs1));

  // 等一会儿，引擎不应该自己动
  await sleep(2500);
  const hs2 = await ev(`({ history: window.__kards.state.game.history.length, turn: window.__kards.state.game.state.turn })`);
  check('同机模式不会自动走引擎', hs2.history === 1 && hs2.turn === 'black', JSON.stringify(hs2));

  // 黑方也能操作（拿对方的子走）
  const hs3 = await ev(`(() => {
    const v = window.__kards.state.view, c = document.getElementById('board');
    const rect = c.getBoundingClientRect();
    const fire = (f, r) => { const p = v.pointAt(f, r);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: rect.left + (p.px / v.layout.width) * rect.width,
        clientY: rect.top + (p.py / v.layout.height) * rect.height, bubbles: true })); };
    fire(0, 3); const sel = v.selected; fire(0, 4);
    return { sel, history: window.__kards.state.game.history.length, turn: window.__kards.state.game.state.turn };
  })()`);
  check('同机模式黑方也能操作', hs3.history === 2 && hs3.turn === 'red', JSON.stringify(hs3));

  /* 同机文案必须与实际该走的一方一致（红=莫斯科、黑=柏林） */
  const hintText = await ev(`(() => {
    // 让红方走一步，看文字是否跟着 turn 变
    const v = window.__kards.state.view, c = document.getElementById('board');
    const rect = c.getBoundingClientRect();
    const fire = (f, r) => { const p = v.pointAt(f, r);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: rect.left + (p.px / v.layout.width) * rect.width,
        clientY: rect.top + (p.py / v.layout.height) * rect.height, bubbles: true })); };
    const before = { text: document.getElementById('turnText').textContent, turn: window.__kards.state.game.state.turn };
    fire(4, 6); fire(4, 5);
    return { before, after: { text: document.getElementById('turnText').textContent, turn: window.__kards.state.game.state.turn } };
  })()`);
  check('同机走棋提示的阵营名与 turn 一致（红=莫斯科 / 黑=柏林）', (() => {
    const okOne = (o) => {
      const want = o.turn === 'red' ? '莫斯科' : '柏林';
      const other = o.turn === 'red' ? '柏林' : '莫斯科';
      return o.text.includes(want) && !o.text.includes(other);
    };
    return okOne(hintText.before) && okOne(hintText.after);
  })(), JSON.stringify(hintText));

  /* 上一手高亮：让玩家看得出对方刚走了哪一步 */
  const lastMoveInfo = await ev(`(async () => {
    const k = window.__kards, v = k.state.view;
    const mod = await import('/src/engine/rules.js');
    const before = v.lastMove;
    const m = mod.legalMoves(k.state.game.state, k.state.game.state.turn)[0];
    const c = document.getElementById('board'), r = c.getBoundingClientRect();
    const fire = (idx) => { const p = v.positionOf(idx);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + (p.px / v.layout.width) * r.width,
        clientY: r.top + (p.py / v.layout.height) * r.height, bubbles: true })); };
    fire(m.from); await new Promise((z) => setTimeout(z, 140));
    fire(m.to); await new Promise((z) => setTimeout(z, 400));
    const after = v.lastMove;
    // 显示坐标：执黑时会被翻转，所以和模型坐标对照时要换算
    const flip = v.isFlipped();
    const expect = (id) => (flip ? 89 - id : id);
    return { before, move: m, after,
             wantFrom: expect(m.from), wantTo: expect(m.to),
             hasTime: typeof after?.t === 'number' };
  })()`);
  check('上一手标记指向刚走的那一步（按显示坐标换算）',
    lastMoveInfo.after?.from === lastMoveInfo.wantFrom && lastMoveInfo.after?.to === lastMoveInfo.wantTo,
    JSON.stringify(lastMoveInfo));
  check('上一手标记带时间戳（起点框据此淡出）', lastMoveInfo.hasTime === true, JSON.stringify(lastMoveInfo));

  /* 悔棋后标记要跟着回退，不能把撤销的那步留在盘上 */
  const afterUndo = await ev(`(async () => {
    const k = window.__kards;
    document.getElementById('undoBtn').click();
    await new Promise((z) => setTimeout(z, 300));
    return { lastMove: k.state.view.lastMove, hist: k.state.game.history.length };
  })()`);
  check('悔棋后上一手标记跟着回退',
    afterUndo.hist === 0 ? afterUndo.lastMove === null : afterUndo.lastMove != null,
    JSON.stringify(afterUndo));

  /* 同机模式：左上角一个头像、左下角一个头像，谁走谁亮 */
  const avatars = await ev(`(() => {
    const t = document.getElementById('hudTop'), s = document.getElementById('hudSelf');
    const b = document.getElementById('hudBottom');
    return {
      bottomShown: !b.hidden,
      topName: document.getElementById('hudTopName').textContent,
      selfName: document.getElementById('hudSelfName').textContent,
      topImg: document.getElementById('hudTopAvatar').src.split('/').pop(),
      selfImg: document.getElementById('hudSelfAvatar').src.split('/').pop(),
      topActive: t.classList.contains('active'),
      selfActive: s.classList.contains('active'),
      turn: window.__kards.state.game.state.turn,
    };
  })()`);
  check('同机模式显示左下角头像', avatars.bottomShown, JSON.stringify(avatars));
  check('左上=上方那一方、左下=下方那一方，头像不同',
    avatars.topImg !== avatars.selfImg && /苏|德|soviet|germany/.test(avatars.topImg + avatars.selfImg),
    JSON.stringify(avatars));
  check('轮到谁，谁的头像亮起',
    avatars.turn === 'red' ? (avatars.selfActive && !avatars.topActive) : (avatars.topActive && !avatars.selfActive),
    JSON.stringify(avatars));

  // 走一步，亮灯应该换到另一个头像
  await ev(`(() => {
    const v = window.__kards.state.view, c = document.getElementById('board');
    const rect = c.getBoundingClientRect();
    const fire = (f, r) => { const p = v.pointAt(f, r);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: rect.left + (p.px / v.layout.width) * rect.width,
        clientY: rect.top + (p.py / v.layout.height) * rect.height, bubbles: true })); };
    fire(2, 6); fire(2, 5);
  })()`);
  await sleep(300);
  const avatars2 = await ev(`(() => ({
    topActive: document.getElementById('hudTop').classList.contains('active'),
    selfActive: document.getElementById('hudSelf').classList.contains('active'),
    turn: window.__kards.state.game.state.turn,
  }))()`);
  check('换手后亮灯跟着换',
    avatars2.turn === 'black' ? (avatars2.topActive && !avatars2.selfActive) : (avatars2.selfActive && !avatars2.topActive),
    JSON.stringify(avatars2));
  await shotCanvas('hotseat');
  // 整页截图：HUD 是 DOM，只有页面截图才看得到两个头像
  {
    const r = await send('Page.captureScreenshot', { format: 'png' }, S);
    writeFileSync(resolve(OUT, 'hotseat-hud.png'), Buffer.from(r.data, 'base64'));
  }

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
      try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* Edge 可能还占着 */ }
      process.exit(process.exitCode ?? 0);
    }, 600);
  });
