/**
 * 放大预览的回归测试。
 *
 * 棋盘受 9×10 比例限制，卡面在 1400px 窗口下只有 ~45px 宽，名字看不清。
 * 预览做成 DOM 浮层，悬停（桌面）/ 点选（手机）时在棋子旁边放大显示。
 *
 * 运行：node tools/test-peek.js（需要 Edge 与已在跑的服务器）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE_PORT = 10900 + (process.pid % 40);
const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'preview', 'shots');

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

/** 起一个页面，返回操作句柄 */
async function open({ w, h, touch = false, idx = 0 }) {
  const port = BASE_PORT + idx;
  const profile = resolve(ROOT, `.edge-peek-${process.pid}-${idx}`);
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
    width: w, height: h, deviceScaleFactor: touch ? 2 : 1, mobile: touch,
  }, S);
  if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, S);
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/?faction=soviet&level=1&auto=1' }, S);
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    if (await ev(`!!(window.__kards && window.__kards.state.game)`)) break;
  }
  await sleep(800);

  return {
    ev, send, sessionId: S,
    async close() {
      try { ws?.close(); } catch { /* ignore */ }
      edge.kill();
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** 某个模型格在屏幕上的坐标 */
const screenPosOf = `(id) => {
  const v = window.__kards.state.view;
  const c = document.getElementById('board');
  const r = c.getBoundingClientRect();
  const p = v.positionOf(id);
  return { x: r.left + (p.px / v.layout.width) * r.width,
           y: r.top + (p.py / v.layout.height) * r.height };
}`;

console.log('peek');

/* ---------- 桌面：鼠标悬停 ---------- */
{
  const page = await open({ w: 1400, h: 900, idx: 1 });
  try {
    // 取一个红方棋子（红帅附近的一辆……用红马更容易有图）
    const targetId = await page.ev(`(() => {
      const b = window.__kards.state.game.state.board;
      for (let i = 0; i < 90; i++) if (b[i] && b[i].side === 'red' && b[i].type === 'horse') return i;
      return -1;
    })()`);
    await check('桌面上能找到用来测试的棋子', () => {
      if (targetId < 0) throw new Error('没找到红马');
    });

    // 记下"悬停前"的画布宽度，稍后确认浮层预览不会改变布局
    await page.ev(`window.__peekBaseCanvasW = window.__kards.state.view.layout.width`);

    await page.ev(`(() => {
      const pos = (${screenPosOf})(${targetId});
      const c = document.getElementById('board');
      c.dispatchEvent(new MouseEvent('mousemove', {
        clientX: pos.x, clientY: pos.y, bubbles: true }));
    })()`);
    await sleep(400);

    const shown = await page.ev(`(() => {
      const el = document.getElementById('cardPeek');
      if (el.hidden) return { hidden: true };
      const img = document.getElementById('cardPeekImg');
      const r = el.getBoundingClientRect();
      const c = document.getElementById('board').getBoundingClientRect();
      const ov = !(r.right < c.left || r.left > c.right || r.bottom < c.top || r.top > c.bottom);
      return {
        hidden: false,
        name: document.getElementById('cardPeekName').textContent,
        sub: document.getElementById('cardPeekSub').textContent,
        src: img.getAttribute('src'),
        w: Math.round(r.width), h: Math.round(r.height),
        cardW: Math.round(window.__kards.state.view.cardW),
        canvasW: window.__kards.state.view.layout.width,
        baseCanvasW: window.__peekBaseCanvasW,
        overlapsBoard: ov,
        inViewport: r.left >= -0.5 && r.top >= -0.5
          && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
        pointerEvents: getComputedStyle(el).pointerEvents,
        position: getComputedStyle(el).position,
      };
    })()`);

    await check('悬停棋子时弹出放大预览', () => {
      if (shown.hidden) throw new Error('预览没出现');
      if (!shown.src) throw new Error('预览没有图片');
      if (!shown.name) throw new Error('预览没有单位名');
    });
    await check('预览明显比棋盘上的牌大', () => {
      const ratio = shown.w / shown.cardW;
      if (ratio < 2.2) throw new Error(`预览只有 ${shown.w}px，棋盘上 ${shown.cardW}px，放大 ${ratio.toFixed(2)} 倍（应 ≥2.2）`);
    });
    await check('预览不遮挡棋盘、不出视口', () => {
      if (shown.overlapsBoard) throw new Error('预览压住了棋盘');
      if (!shown.inViewport) throw new Error('预览超出视口');
    });
    await check('预览不吃点击（pointer-events: none）', () => {
      if (shown.pointerEvents !== 'none') throw new Error(`pointer-events = ${shown.pointerEvents}`);
    });
    // 宽屏预览是浮层，不该影响画布尺寸（踩过：悬停一下棋盘就缩小一大截）
    await check('浮层预览不会让棋盘缩小', () => {
      const cw = Math.round(shown.canvasW);
      if (Math.abs(cw - shown.baseCanvasW) > 2) {
        throw new Error(`悬停前画布宽 ${shown.baseCanvasW}px，悬停后 ${cw}px（浮层不该改变布局）`);
      }
    });

    /*
     * 关键回归：悬停弹出预览时**不能重建精灵 / 重绘棋局**。
     * 踩过：宽屏预览是 fixed 浮层、不占文档流，但代码无条件 scheduleRemeasure()，
     * 于是悬停一下就走一遍 resize + sync（32 个精灵全部重建、出场动画重播），
     * 用户看到的就是"整个棋局重新渲染了一遍"。
     */
    const hoverCost = await page.ev(`(async () => {
      const k = window.__kards, v = k.state.view;
      const c = document.getElementById('board');
      const r = c.getBoundingClientRect();
      const b = k.state.game.state.board;
      let id = -1;
      for (let i = 0; i < 90; i++) if (b[i] && b[i].side === 'red') { id = i; break; }

      // 先离开棋盘，确保预览是收起状态
      c.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      await new Promise((z) => setTimeout(z, 400));

      let syncs = 0;
      let renders = 0;
      const origSync = v.sync.bind(v);
      const origRender = v.render.bind(v);
      v.sync = function (...a) { syncs++; return origSync(...a); };
      v.render = function (...a) { renders++; return origRender(...a); };

      const p = v.positionOf(id);
      const sx = r.left + (p.px / v.layout.width) * r.width;
      const sy = r.top + (p.py / v.layout.height) * r.height;
      c.dispatchEvent(new MouseEvent('mousemove', { clientX: sx, clientY: sy, bubbles: true }));
      for (let i = 0; i < 30; i++) await new Promise((z) => requestAnimationFrame(z));

      v.sync = origSync;
      v.render = origRender;
      return { syncs, renders, peekShown: !document.getElementById('cardPeek').hidden };
    })()`);

    await check('悬停弹出预览确实显示了', () => {
      if (!hoverCost.peekShown) throw new Error('预览没显示，这条测试没意义');
    });
    await check('悬停弹出预览时不会重建精灵（不重渲染整个棋局）', () => {
      if (hoverCost.syncs > 0) {
        throw new Error(`悬停时 view.sync 被调了 ${hoverCost.syncs} 次（应 0 次）`);
      }
    });

    mkdirSync(OUT, { recursive: true });
    const shot = await page.send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
    writeFileSync(resolve(OUT, 'peek-desktop.png'), Buffer.from(shot.data, 'base64'));

    // 移开 → 收起
    await page.ev(`(() => {
      const c = document.getElementById('board');
      const r = c.getBoundingClientRect();
      c.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      void r;
    })()`);
    await sleep(300);
    await check('鼠标离开棋盘后预览收起', async () => {
      const hidden = await page.ev(`document.getElementById('cardPeek').hidden`);
      if (!hidden) throw new Error('预览还在');
    });
  } finally {
    await page.close();
  }
}

/* ---------- 手机：点选 ---------- */
{
  const page = await open({ w: 430, h: 932, touch: true, idx: 2 });
  try {
    const targetId = await page.ev(`(() => {
      const b = window.__kards.state.game.state.board;
      for (let i = 0; i < 90; i++) if (b[i] && b[i].side === 'red' && b[i].type === 'cannon') return i;
      return -1;
    })()`);

    // 手机靠点选触发：直接派发 pointerdown（走的是真人点击那条路径）
    await page.ev(`(() => {
      const pos = (${screenPosOf})(${targetId});
      const c = document.getElementById('board');
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: pos.x, clientY: pos.y, bubbles: true, pointerType: 'touch' }));
    })()`);
    await sleep(400);

    const info = await page.ev(`(() => {
      const el = document.getElementById('cardPeek');
      if (el.hidden) return { hidden: true };
      const r = el.getBoundingClientRect();
      const c = document.getElementById('board').getBoundingClientRect();
      const v = window.__kards.state.view;
      const ov = !(r.right < c.left || r.left > c.right || r.bottom < c.top || r.top > c.bottom);
      return {
        hidden: false,
        w: Math.round(r.width),
        cardW: Math.round(v.cardW),
        // 窄屏时预览排在画布**下方**（不压棋盘、不挡手指）
        belowBoard: r.top >= c.bottom - 0.5,
        overlapsBoard: ov,
        canvas: [Math.round(c.left), Math.round(c.top), Math.round(c.right), Math.round(c.bottom)],
        peek: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
        inViewport: r.left >= -0.5 && r.top >= -0.5
          && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
        name: document.getElementById('cardPeekName').textContent,
      };
    })()`);

    await check('手机上点选棋子时弹出预览', () => {
      if (info.hidden) throw new Error('预览没出现');
      if (!info.name) throw new Error('没有单位名');
    });
    await check('手机上预览排在画布下方、不压棋盘', () => {
      if (!info.belowBoard || info.overlapsBoard) {
        throw new Error(
          `预览 ${JSON.stringify(info.peek)} 与画布 ${JSON.stringify(info.canvas)} 重叠/不在下方`,
        );
      }
    });
    await check('手机上预览不出视口', () => {
      if (!info.inViewport) throw new Error('预览超出视口');
    });
    await check('手机上预览同样明显更大', () => {
      const ratio = info.w / info.cardW;
      if (ratio < 2.2) throw new Error(`放大只有 ${ratio.toFixed(2)} 倍`);
    });

    mkdirSync(OUT, { recursive: true });
    const shot = await page.send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
    writeFileSync(resolve(OUT, 'peek-mobile.png'), Buffer.from(shot.data, 'base64'));

    // 点空白处收起
    await page.ev(`(() => {
      const c = document.getElementById('board');
      const r = c.getBoundingClientRect();
      // 棋盘左上角外侧的空白
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + 3, clientY: r.top + 3, bubbles: true, pointerType: 'touch' }));
    })()`);
    await sleep(300);
    await check('手机点空白处收起预览', async () => {
      const hidden = await page.ev(`document.getElementById('cardPeek').hidden`);
      if (!hidden) throw new Error('预览还在');
    });
  } finally {
    await page.close();
  }
}

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
