/**
 * 翻转视角下对手着法的落点是否正确。
 *
 * 用户反馈："我玩德国时，对面苏联走了，结果走的过程投影到我这里了"
 * —— 怀疑执黑（整盘 180° 翻转）时，对手那一步的动画/落点画到了镜像位置。
 *
 * 这里真开一个联机对局：房主执红、客机执黑（翻转），房主走一步，
 * 然后在客机侧核对：
 *   - 棋盘模型状态正确（子确实走到了 msg.to）
 *   - 该子的精灵在**显示坐标**下位于 rotate180(to) 那一格
 *   - 被吃子时的翻倒动画位置也一致
 *
 * 运行：node tools/test-lan-flip.js（需要 Edge 与已在跑的服务器）
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 12100 + (process.id ?? process.pid) % 200;
const PROFILE = resolve(import.meta.dirname, '..', `.edge-lanflip-${process.pid}`);
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

console.log('lan-flip');

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

  // 房主建房
  await send('Page.navigate', { url: BASE }, host.sessionId);
  await sleep(2500);
  await host.ev(`document.querySelector('#modeRow .level[data-mode="host"]').click()`);
  await sleep(1800);
  const room = await host.ev(`document.getElementById('roomCode').textContent`);
  const url = await host.ev(`document.getElementById('lanUrl').textContent`);

  // 客机加入
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

  // 房主开局（房主执红=不翻转，客机执黑=翻转）
  await host.ev(`document.getElementById('startBtn').click()`);
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const ok = await guest.ev(`!!(window.__kards && window.__kards.state.game)`);
    if (ok) break;
  }
  await sleep(1200);

  const sides = await guest.ev(`(() => {
    const k = window.__kards;
    return { human: k.state.humanSide, flipped: k.state.view.isFlipped(), turn: k.state.game.state.turn };
  })()`);
  await check('客机执黑且棋盘翻转', () => {
    if (sides.human !== 'black') throw new Error(`客机执 ${sides.human}，应为 black`);
    if (sides.flipped !== true) throw new Error('棋盘没有翻转');
  });

  // 房主（红）走一步：优先选一个能产生位移的合法着法
  const move = await host.ev(`(async () => {
    const k = window.__kards;
    const mod = await import('/src/engine/rules.js');
    const st = k.state.game.state;
    const ms = mod.legalMoves(st, st.turn);
    const m = ms.find((x) => !st.board[x.to]) || ms[0];
    const v = k.state.view;
    const c = document.getElementById('board');
    const r = c.getBoundingClientRect();
    const fire = (idx) => { const p = v.positionOf(idx);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + (p.px / v.layout.width) * r.width,
        clientY: r.top + (p.py / v.layout.height) * r.height, bubbles: true, pointerType: 'mouse' })); };
    fire(m.from); await new Promise((z) => setTimeout(z, 150)); fire(m.to);
    return m;
  })()`);

  await sleep(2500);

  const view = await guest.ev(`(() => {
    const k = window.__kards, v = k.state.view;
    const b = k.state.game.state.board;
    const from = ${move.from}, to = ${move.to};
    const sp = v.sprites.get(to);
    // 期望的显示位置
    const flip = v.isFlipped();
    const shown = flip ? 89 - to : to;
    const want = v.layout.pointAt(shown % 9, Math.floor(shown / 9));
    return {
      boardAtTo: b[to] ? b[to].type + '/' + b[to].side : null,
      boardAtFrom: b[from] ? b[from].type + '/' + b[from].side : null,
      spriteAtTo: !!sp,
      spriteX: sp ? +sp.x.toFixed(1) : null,
      spriteY: sp ? +sp.y.toFixed(1) : null,
      wantX: +want.px.toFixed(1),
      wantY: +want.py.toFixed(1),
      flipped: flip,
      to, shown,
      // 反向：模型 from 位置在显示空间里对应哪一格
      fromShown: flip ? 89 - from : from,
    };
  })()`);

  await check('客机侧棋盘状态正确（子落在模型坐标 to，起点已空）', () => {
    if (!view.boardAtTo) throw new Error(`模型格 ${view.to} 上没有子`);
    if (view.boardAtFrom) throw new Error(`起点 ${move.from} 上还有子`);
  });
  await check('该子的精灵落在"翻转后"对应的显示格上', () => {
    if (!view.spriteAtTo) throw new Error(`模型格 ${view.to} 的精灵不存在`);
    const dx = Math.abs(view.spriteX - view.wantX);
    const dy = Math.abs(view.spriteY - view.wantY);
    if (dx > 1 || dy > 1) {
      throw new Error(
        `精灵在 (${view.spriteX},${view.spriteY})，翻转后应在 (${view.wantX},${view.wantY})`
        + `  [模型 to=${view.to} → 显示 ${view.shown}]`,
      );
    }
  });

  /*
   * 推翻倒动画：让**客机自己（黑方）**走一步吃子。
   * 注意不能用"房主随便点一个合法着法"——点击只对"当前该走那一方"生效，
   * 房主点在黑方回合会被忽略（第一版就是这么误判的）。
   */
  const guestCapture = await guest.ev(`(async () => {
    const k = window.__kards;
    const mod = await import('/src/engine/rules.js');
    const st = k.state.game.state;
    if (st.turn !== 'black') return { skip: 'not-black-turn', turn: st.turn };
    const ms = mod.legalMoves(st, st.turn).filter((m) => st.board[m.to]);
    if (!ms.length) return { skip: 'no-capture' };
    const m = ms[0];
    const v = k.state.view;
    const c = document.getElementById('board');
    const r = c.getBoundingClientRect();
    const fire = (idx) => { const p = v.positionOf(idx);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + (p.px / v.layout.width) * r.width,
        clientY: r.top + (p.py / v.layout.height) * r.height, bubbles: true, pointerType: 'mouse' })); };
    fire(m.from); await new Promise((z) => setTimeout(z, 150));
    const ok = v.targets.has(m.to);
    if (!ok) return { skip: 'target-not-offered', m };
    fire(m.to);
    return m;
  })()`);

  if (guestCapture && !guestCapture.skip) {
    await sleep(400);
    const cap = await guest.ev(`(() => {
      const k = window.__kards, v = k.state.view;
      const to = ${guestCapture.to};
      const flip = v.isFlipped();
      const shown = flip ? 89 - to : to;
      const want = v.layout.pointAt(shown % 9, Math.floor(shown / 9));
      const f = v.fallen[0];
      return {
        fallenCount: v.fallen.length,
        fallenX: f ? +f.x.toFixed(1) : null,
        fallenY: f ? +f.y.toFixed(1) : null,
        wantX: +want.px.toFixed(1),
        wantY: +want.py.toFixed(1),
        to, shown,
      };
    })()`);
    await check('被吃子的翻倒动画画在翻转后的格子', () => {
      if (!cap.fallenCount) throw new Error('没有翻倒动画');
      const dx = Math.abs(cap.fallenX - cap.wantX);
      const dy = Math.abs(cap.fallenY - cap.wantY);
      if (dx > 1 || dy > 1) {
        throw new Error(
          `翻倒位置 (${cap.fallenX},${cap.fallenY})，应为 (${cap.wantX},${cap.wantY})`
          + `  [模型 to=${cap.to} → 显示 ${cap.shown}]`,
        );
      }
    });
  } else {
    console.log('      （客机这一步没有可吃的着法，跳过翻倒动画检查）:', JSON.stringify(guestCapture));
  }

  /*
   * 关键：**动画过程中**的路径。
   *
   * 用户看到的是"走的过程投影到我这里" —— 也就是说落点可能对、但**起点**不对
   * （从镜像位置滑过来）。只在着法落地后检查是测不出这个的。
   * 这里让对手再走一步，客机侧立刻高频率采样精灵位置：
   *   - 翻转时：起点应当是 rotate180(from)，终点 rotate180(to)
   *   - 绝不能出现"起点=from（未翻转）"这种镜像滑行
   */
  const track = await guest.ev(`(() => {
    const k = window.__kards, v = k.state.view;
    window.__track = [];
    if (window.__trackTimer) clearInterval(window.__trackTimer);
    window.__trackTimer = setInterval(() => {
      const out = [];
      for (const s of v.sprites.values()) out.push([s.id, +s.x.toFixed(1), +s.y.toFixed(1), +s.tx.toFixed(1), +s.ty.toFixed(1)]);
      window.__track.push(out);
      if (window.__track.length > 40) clearInterval(window.__trackTimer);
    }, 16);
    return true;
  })()`);
  void track;

  const move2 = await host.ev(`(async () => {
    const k = window.__kards;
    const mod = await import('/src/engine/rules.js');
    const st = k.state.game.state;
    if (st.turn !== 'red') return null;
    const ms = mod.legalMoves(st, st.turn).filter((x) => !st.board[x.to]);
    if (!ms.length) return null;
    const m = ms[0];
    const v = k.state.view;
    const c = document.getElementById('board');
    const r = c.getBoundingClientRect();
    const fire = (idx) => { const p = v.positionOf(idx);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + (p.px / v.layout.width) * r.width,
        clientY: r.top + (p.py / v.layout.height) * r.height, bubbles: true, pointerType: 'mouse' })); };
    fire(m.from); await new Promise((z) => setTimeout(z, 150)); fire(m.to);
    return m;
  })()`);

  await sleep(1500);
  if (move2) {
    const path = await guest.ev(`(() => {
      const k = window.__kards, v = k.state.view;
      clearInterval(window.__trackTimer);
      const flip = v.isFlipped();
      const F = ${move2.from}, T = ${move2.to};
      const at = (id) => { const shown = flip ? 89 - id : id;
        return v.layout.pointAt(shown % 9, Math.floor(shown / 9)); };
      const fromP = at(F), toP = at(T);
      // 未翻转时的位置（镜像错误的情况）
      const fromRaw = v.layout.pointAt(F % 9, Math.floor(F / 9));
      const near = (x, y, p, tol) => Math.abs(x - p.px) < tol && Math.abs(y - p.py) < tol;
      let sawAtRawFrom = 0;
      let firstSeen = null;
      for (const frame of window.__track) {
        const rec = frame.find((r) => r[0] === T);
        if (!rec) continue;
        if (!firstSeen) firstSeen = { x: rec[1], y: rec[2] };
        if (near(rec[1], rec[2], fromRaw, 2)) sawAtRawFrom++;
      }
      return {
        flip, F, T,
        fromWant: [ +fromP.px.toFixed(1), +fromP.py.toFixed(1) ],
        toWant: [ +toP.px.toFixed(1), +toP.py.toFixed(1) ],
        fromRaw: [ +fromRaw.px.toFixed(1), +fromRaw.py.toFixed(1) ],
        firstSeen,
        sawAtRawFrom,
        frames: window.__track.length,
      };
    })()`);

    await check('对手着法的动画起点是"翻转后"的格子（不是镜像位置）', () => {
      if (!path.frames) throw new Error('没有采到动画帧');
      if (path.sawAtRawFrom > 0) {
        throw new Error(
          `动画过程中出现在未翻转的起点 ${JSON.stringify(path.fromRaw)} 上 ${path.sawAtRawFrom} 帧`
          + `（翻转后起点应为 ${JSON.stringify(path.fromWant)}）`,
        );
      }
      // 采样到的第一帧应当靠近"翻转后的起点"
      if (path.firstSeen) {
        const dx = Math.abs(path.firstSeen.x - path.fromWant[0]);
        const dy = Math.abs(path.firstSeen.y - path.fromWant[1]);
        const len = Math.hypot(path.fromRaw[0] - path.fromWant[0], path.fromRaw[1] - path.fromWant[1]);
        if (len > 20 && Math.hypot(dx, dy) > len * 0.6) {
          throw new Error(
            `第一帧在 ${JSON.stringify(path.firstSeen)}，翻转后起点是 ${JSON.stringify(path.fromWant)}`
            + `（未翻转起点 ${JSON.stringify(path.fromRaw)}），起点像是没翻转`,
          );
        }
      }
    });
  } else {
    console.log('      （房主这一步没走到，跳过动画路径检查）');
  }
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  edge.kill();
  await sleep(300);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);