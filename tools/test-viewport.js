/**
 * 多视口 × 两人同机模式下的布局回归。
 *
 * 盯的是"浮层互相压"这类只在特定尺寸才出现的问题：
 *   - 画布被顶部 HUD 压住
 *   - 画布被底部版权声明压住
 *   - 左下角"自己"头像被版权声明压住
 *   - 牌伸出画布
 *   - 画布出视口
 *
 * 运行：node tools/test-viewport.js（需要 Edge 与已在跑的服务器）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE_PORT = 10300 + (process.pid % 60);
const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'preview', 'shots');

/** 覆盖手机竖屏、横屏、笔记本、以及"页面被缩小"后的窄视口 */
const CASES = [
  [320, 568], [360, 640], [390, 844], [430, 932],
  [575, 648], [575, 1080], [500, 520], [700, 500],
  [844, 390], [1280, 720], [1400, 900],
];

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(w, h, idx) {
  const port = BASE_PORT + idx;
  const profile = resolve(ROOT, `.edge-vp-${process.pid}-${idx}`);
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${w},${h}`, 'about:blank',
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

  try {
    let wsUrl = null;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
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

    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 2, mobile: true,
    }, S);
    // 走真人路径：选边 → 勾两人同机 → 开始（这样左下角头像才在）
    await send('Page.navigate', { url: 'http://127.0.0.1:5173/' }, S);
    await sleep(4200);
    await ev(`document.querySelector('.faction[data-id="soviet"]').click()`);
    await sleep(200);
    await ev(`document.getElementById('hotseatChk').click()`);
    await sleep(200);
    await ev(`document.getElementById('startBtn').click()`);
    let started = false;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      if (await ev(`!!(window.__kards && window.__kards.state.game)`)) { started = true; break; }
    }
    if (!started) throw new Error('没能开局');

    const info = await ev(`(() => {
      const r = (el) => { const b = el.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
      const cv = document.getElementById('board');
      const hud = document.getElementById('hud');
      const bot = document.getElementById('hudBottom');
      const no = document.getElementById('licenseNotice');
      const ov = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
      const v = window.__kards.state.view;
      let worst = 0, n = 0;
      for (const sp of v.sprites.values()) {
        const sc = Number(sp.scale) || 1;
        const hw = v.cardW / 2 * sc, hh = v.cardH / 2 * sc;
        worst = Math.max(worst, -(sp.x - hw), -(sp.y - hh), (sp.x + hw) - v.layout.width, (sp.y + hh) - v.layout.height);
        n++;
      }
      const cR = r(cv), noR = r(no), botR = (bot && !bot.hidden) ? r(bot) : null;
      return {
        视口: [innerWidth, innerHeight],
        牌数: n, 越界: +worst.toFixed(1),
        画布: cR, 声明: noR, 左下头像: botR,
        画布压HUD: cR[1] < r(hud)[3] - 0.5,
        画布压声明: cR[3] > noR[1] + 0.5,
        画布压底部头像: botR ? ov(cR, botR) : false,
        预留: [Number(v.reserveTop.toFixed(1)), Number(v.reserveBottom.toFixed(1))],
        bodyPadding: getComputedStyle(document.body).padding,
        hudBottomRect: botR,
        头像压声明: botR ? ov(botR, noR) : false,
        有左下头像: !!botR,
        声明出视口: noR[3] > innerHeight + 0.5,
        画布出视口: cR[0] < -0.5 || cR[1] < -0.5 || cR[2] > innerWidth + 0.5 || cR[3] > innerHeight + 0.5,
      };
    })()`);
    if (w === 575 && h === 648) {
      const shot = await send('Page.captureScreenshot', { format: 'png' }, S);
      mkdirSync(OUT, { recursive: true });
      writeFileSync(resolve(OUT, 'viewport-575x648.png'), Buffer.from(shot.data, 'base64'));
    }
    return info;
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    edge.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 探针结果必须齐全，否则直接失败（避免 undefined 比较造成假绿） */
function requireOk(info, label) {
  if (!info || typeof info !== 'object') throw new Error(`${label}：没有结果`);
  for (const key of ['视口', '牌数', '越界', '画布', '声明']) {
    if (info[key] === undefined) throw new Error(`${label}：缺少字段 ${key}`);
  }
  if (info.牌数 !== 32) throw new Error(`${label}：只检查到 ${info.牌数} 张牌`);
  if (!Number.isFinite(info.越界)) throw new Error(`${label}：越界值非法`);
  return info;
}

console.log('viewport');

for (let i = 0; i < CASES.length; i++) {
  const [w, h] = CASES[i];
  let info;
  const label = `${w}×${h}`;
  try {
    info = requireOk(await probe(w, h, i), label);
  } catch (err) {
    await check(`${label}：探针有效`, () => { throw err; });
    continue;
  }

  await check(`${label}：牌不越界、画布不出视口`, () => {
    if (info.越界 > 0.5) throw new Error(`牌越界 ${info.越界}px`);
    if (info.画布出视口) throw new Error(`画布 ${JSON.stringify(info.画布)} 超出视口 ${JSON.stringify(info.视口)}`);
  });

  await check(`${label}：画布不被 HUD / 声明 / 底部头像压住`, () => {
    if (info.画布压HUD) throw new Error('画布被顶部 HUD 压住');
    if (info.画布压声明) throw new Error(`画布底 ${info.画布[3]} 超过声明顶 ${info.声明[1]}`);
    if (info.画布压底部头像) {
      throw new Error(
        `画布 ${JSON.stringify(info.画布)} 与底部头像 ${JSON.stringify(info.左下头像)} 重叠；`
        + ` 预留=${JSON.stringify(info.预留)} bodyPadding=${info.bodyPadding}`
        + ` 声明=${JSON.stringify(info.声明)} 视口=${JSON.stringify(info.视口)}`,
      );
    }
  });

  await check(`${label}：左下头像不被版权声明压住`, () => {
    if (!info.有左下头像) throw new Error('两人同机模式下应当显示左下头像');
    if (info.头像压声明) {
      throw new Error(`头像 ${JSON.stringify(info.左下头像)} 与声明 ${JSON.stringify(info.声明)} 重叠`);
    }
  });

  await check(`${label}：声明完整在视口内`, () => {
    if (info.声明出视口) throw new Error(`声明底 ${info.声明[3]} 超出视口高 ${info.视口[1]}`);
  });
}

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
