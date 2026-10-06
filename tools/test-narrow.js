/**
 * 窄窗口下"卡牌不能被画布裁掉"的回归测试。
 *
 * 起因：窗口缩到 400px 宽时，棋盘四周的留白与卡面的比例变化，
 * 顶行 / 底行的牌会探出画布被切掉（用户实际看到的现象）。
 * 这里在多个窄尺寸下真开局，逐个核对每张牌的四角是否都在画布内。
 *
 * 运行：node tools/test-narrow.js
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE_PORT = 9800 + (process.pid % 60);
const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'preview', 'shots');
const SIZES = [[320, 568], [360, 640], [390, 844], [404, 681], [430, 932], [700, 500], [1400, 900]];

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

/* ---- PNG 编码（导出 canvas 真像素用） ---- */
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC_T[(c ^ b[i]) & 0xff];
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
function png(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });

/** 在指定窗口尺寸下开局，返回每张牌四角的越界量 */
async function probe(w, h, idx, opts = {}) {
  const port = BASE_PORT + idx;
  const profile = resolve(ROOT, `.edge-narrow-${process.pid}-${idx}`);
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

    await send('Page.navigate', { url: 'http://127.0.0.1:5173/?faction=soviet&level=1&auto=1' }, S);
    await sleep(5200);

    // 可选：模拟手机旋转 / 视口变化，验证会重算
    if (opts.rotateTo) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: opts.rotateTo[0],
        height: opts.rotateTo[1],
        deviceScaleFactor: opts.rotateTo[2] ?? 1,
        mobile: true,
      }, S);
      // 等防抖重算落地（main.js 里是 180ms + 450ms 两次）
      await sleep(1400);
    }

    const info = await ev(`(() => {
      const c = document.getElementById('board');
      const k = window.__kards;
      if (!k) return { error: '页面没加载出 __kards（模块加载失败？）' };
      const v = k.state && k.state.view;
      if (!v || !v.layout) return { error: '没开局' };
      const W = v.layout.width, H = v.layout.height;
      let worst = { over: 0, id: null, side: null };
      let checked = 0;
      for (const s of v.sprites.values()) {
        const sc = Number(s.scale);
        if (!Number.isFinite(sc)) return { error: 'sprite scale 不是数字: ' + s.scale + ' (id ' + s.id + ')' };
        // 牌未旋转/未倒下时的四角；倒下时用外接圆近似（那时另有夹取）
        const hw = v.cardW / 2 * sc, hh = v.cardH / 2 * sc;
        const over = Math.max(0, -(s.x - hw), -(s.y - hh), (s.x + hw) - W, (s.y + hh) - H);
        if (!Number.isFinite(over)) return { error: 'over 不是数字, sprite ' + s.id };
        checked++;
        if (over > worst.over) worst = { over, id: s.id, side: s.side };
      }
      const rect = c.getBoundingClientRect();
      const hudRect = document.getElementById('hud').getBoundingClientRect();
      const noticeRect = document.getElementById('licenseNotice').getBoundingClientRect();

      /*
       * 独立于精灵坐标的检查：卡面尺寸必须与几何留白自洽。
       *
       * 只看精灵坐标是不够的 —— 精灵的夹取也是用 v.cardW/v.cardH 算的，
       * 卡片尺寸取错时会"自洽地"通过（真实踩过：geometry 用 0.65 反推留白，
       * 而 theme 仍按 0.86 画牌，牌照样溢出）。
       * 所以这里直接用 v.cardH 去比 几何留白*2 + 棋盘高 是否 >= 卡高 + 棋盘高，
       * 也就是「最外两行的牌放得下吗」。
       */
      const needH = v.cardH;                        // 上下各伸半张 = 整张卡高
      const haveH = 2 * (v.layout.padding.top + v.layout.padding.bottom); // 上下留白合计
      const needW = v.cardW;
      const haveW = 2 * (v.layout.padding.left + v.layout.padding.right);

      return {
        W, H, checked, worst,
        card: [Number(v.cardW.toFixed(1)), Number(v.cardH.toFixed(1))],
        // 留白 vs 卡面：正数表示放得下
        fitV: Number((haveH - needH).toFixed(1)),
        fitH: Number((haveW - needW).toFixed(1)),
        canvasRect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
        outOfViewport: rect.left < -0.5 || rect.top < -0.5
          || rect.right > innerWidth + 0.5 || rect.bottom > innerHeight + 0.5,
        overlapsHud: rect.top < hudRect.bottom - 0.5 && rect.left < hudRect.right - 0.5,
        overlapsNotice: rect.bottom > noticeRect.top + 0.5,
        viewport: [innerWidth, innerHeight],
      };
    })()`);

    const b64 = await ev(`(() => {
      const c = document.getElementById('board');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let bin = '';
      const CH = 8192;
      for (let i = 0; i < d.length; i += CH) bin += String.fromCharCode.apply(null, d.subarray(i, i + CH));
      return btoa(bin);
    })()`);
    const size = await ev(`(() => { const c = document.getElementById('board'); return [c.width, c.height]; })()`);
    writeFileSync(resolve(OUT, `narrow-${w}x${h}.png`), png(Buffer.from(b64, 'base64'), size[0], size[1]));

    return info;
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    edge.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log('narrow');

/**
 * 取出探针结果并**立刻硬校验**。
 *
 * ⚠️ 不能让 { error } 流到各条断言里去：像 fitV 这种字段在出错时是 undefined，
 * 而 `undefined < -0.5` 是 false —— 测试会"假绿"。
 * （真的踩过：故意把 theme.js 改坏后，23 项照样全过。）
 */
function requireOk(info, label) {
  if (!info || typeof info !== 'object') {
    throw new Error(`${label}：探针没有返回结果（${JSON.stringify(info)}）`);
  }
  if (info.error) throw new Error(`${label}：${info.error}`);
  if (info.checked !== 32) throw new Error(`${label}：只检查到 ${info.checked} 张牌`);
  for (const key of ['worst', 'card', 'fitV', 'fitH', 'canvasRect', 'viewport']) {
    if (info[key] === undefined) throw new Error(`${label}：探针缺少字段 ${key}`);
  }
  if (![info.fitV, info.fitH, info.worst.over].every(Number.isFinite)) {
    throw new Error(`${label}：探针数值非法 ${JSON.stringify({ fitV: info.fitV, fitH: info.fitH, over: info.worst.over })}`);
  }
  return info;
}

for (let i = 0; i < SIZES.length; i++) {
  const [w, h] = SIZES[i];
  const raw = await probe(w, h, i);
  let info;
  await check(`${w}×${h}：探针有效（探到 32 张牌、字段齐全）`, () => {
    info = requireOk(raw, `${w}×${h}`);
  });
  if (!info) continue; // 探针本身无效时，后面的断言没有意义
  await check(`${w}×${h}：32 张牌全部在画布内`, () => {
    if (info.worst.over > 0.5) {
      throw new Error(
        `牌 #${info.worst.id}(${info.worst.side}) 越界 ${info.worst.over.toFixed(1)}px；` +
        `画布 ${info.W.toFixed(0)}×${info.H.toFixed(0)}，卡面 ${info.card.join('×')}`,
      );
    }
  });
  await check(`${w}×${h}：画布不出视口、也不被 HUD / 版权声明压住`, () => {
    if (info.outOfViewport) {
      throw new Error(`画布 ${JSON.stringify(info.canvasRect)} 超出视口 ${JSON.stringify(info.viewport)}`);
    }
    if (info.overlapsHud) throw new Error('画布被顶部 HUD 压住');
    if (info.overlapsNotice) throw new Error('画布被底部版权声明压住');
  });
  await check(`${w}×${h}：卡面尺寸与几何留白自洽（防两处常量不同步）`, () => {
    // 留白合计必须 >= 卡面尺寸；不足说明 theme.js 与 geometry.js 的
    // CARD_WIDTH_UNITS 不一致了（这正是"手机上还是溢出"的真凶）
    if (info.fitV < -0.5) {
      throw new Error(`纵向放不下：留白合计比卡高少 ${(-info.fitV).toFixed(1)}px（卡 ${info.card.join('×')}）`);
    }
    if (info.fitH < -0.5) {
      throw new Error(`横向放不下：留白合计比卡宽少 ${(-info.fitH).toFixed(1)}px`);
    }
  });
}

/* 关键回归：手机旋转 / 动态视口变化后必须**重算**，不能留着旧尺寸 */
{
  const raw = await probe(390, 844, 90, { rotateTo: [844, 390] });
  let info;
  await check('手机旋转后探针有效', () => {
    info = requireOk(raw, '旋转后');
  });
  if (info) {
    await check('手机旋转（390×844 → 844×390）后自动重算，牌不越界', () => {
      if (info.worst.over > 0.5) {
        throw new Error(
          `旋转后牌 #${info.worst.id} 越界 ${info.worst.over.toFixed(1)}px；` +
          `画布 ${info.W.toFixed(0)}×${info.H.toFixed(0)}，视口 ${JSON.stringify(info.viewport)}`,
        );
      }
    });
    await check('旋转后画布仍在视口内、不被浮层压住', () => {
      if (info.outOfViewport) throw new Error(`画布 ${JSON.stringify(info.canvasRect)} 超出视口 ${JSON.stringify(info.viewport)}`);
      if (info.overlapsHud) throw new Error('旋转后画布被 HUD 压住');
      if (info.overlapsNotice) throw new Error('旋转后画布被版权声明压住');
    });
    await check('旋转后卡面与留白仍自洽', () => {
      if (info.fitV < -0.5) throw new Error(`纵向放不下，差 ${(-info.fitV).toFixed(1)}px`);
      if (info.fitH < -0.5) throw new Error(`横向放不下，差 ${(-info.fitH).toFixed(1)}px`);
    });
  }
}

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
