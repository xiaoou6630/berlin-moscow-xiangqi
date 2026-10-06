/**
 * 界面提示（按改过的规则）。
 *
 * ⚠️ 规则已改：**不再过滤"送将"**，任何子都能随便走，吃掉对方的将/帅才赢。
 * 所以：
 *   - 不会再有"这一步会露出帅被吃（送将）"这种提示 —— 因为它不再是限制
 *   - "选中了却没有可走点"只剩**几何原因**（象眼被塞、士出不了宫…），
 *     这时才给一句提示
 *   - 被将军时帅/将仍会有红圈提示（但那不再意味着"必须动将"）
 *
 * 运行：node tools/test-hint.js
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 14400 + ((process.pid ?? 0) % 150);
const PROFILE = resolve(import.meta.dirname, '..', `.edge-hint2-${process.pid}`);
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

console.log('hint（新规则）');

try {
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* 等 */ }
    await sleep(200);
  }
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

  /*
   * 用**两人同机**模式打开：这样引擎完全不参与，
   * 我摆的局面不会被 AI 应招打断（第一版用 ?auto=1，点一下车就轮到黑方 CPU，
   * 后面的断言全被 aiThinking / turn 变化搞垮）。
   */
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/?faction=soviet' }, S);
  await sleep(2500);
  await ev(`document.getElementById('hotseatChk').click()`);
  await sleep(250);
  await ev(`document.getElementById('startBtn').click()`);
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    if (await ev(`!!(window.__kards && window.__kards.state.game)`)) break;
  }
  await sleep(1200);
  const mode = await ev(`window.__kards.state.playMode`);
  if (mode !== 'hotseat') throw new Error(`期望 hotseat 模式，实际 ${mode}`);

  // 捕获页面异常：如果点击处理里抛错了，这里能看到
  await ev(`(() => {
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)));
    return true;
  })()`);

  const pageErrs = () => ev('window.__errs ?? []');

  /** 摆局面 → 点某个子 → 返回界面状态 */
  const probe = (rows, file, rank) => ev(`(() => {
    const k = window.__kards, v = k.state.view;
    const CH = {
      G: { type: 'general', side: 'red' }, g: { type: 'general', side: 'black' },
      A: { type: 'advisor', side: 'red' }, a: { type: 'advisor', side: 'black' },
      E: { type: 'elephant', side: 'red' }, e: { type: 'elephant', side: 'black' },
      H: { type: 'horse', side: 'red' }, h: { type: 'horse', side: 'black' },
      R: { type: 'chariot', side: 'red' }, r: { type: 'chariot', side: 'black' },
      C: { type: 'cannon', side: 'red' }, c: { type: 'cannon', side: 'black' },
      P: { type: 'pawn', side: 'red' }, p: { type: 'pawn', side: 'black' },
    };
    const rows = ${JSON.stringify(rows)};
    const board = new Array(90).fill(null);
    rows.forEach((row, r) => [...row].forEach((ch, f) => {
      if (ch !== '.') board[r * 9 + f] = { ...CH[ch] };
    }));
    k.state.game.state.board = board;
    k.state.game.state.turn = 'red';
    k.state.game.history = [];
    k.state.game.lastMove = null;
    k.state.aiThinking = false;
    k.state.over = false;
    k.refreshView({ animate: false });
    const overAfterRefresh = k.state.over;

    const idx = ${rank} * 9 + ${file};
    const c = document.getElementById('board');
    const rect = c.getBoundingClientRect();
    const p = v.positionOf(idx);
    document.getElementById('banner').hidden = true;
    c.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: rect.left + (p.px / v.layout.width) * rect.width,
      clientY: rect.top + (p.py / v.layout.height) * rect.height,
      bubbles: true, pointerType: 'mouse' }));

    return {
      selected: v.selected,
      targets: v.targets.size,
      banner: document.getElementById('banner').hidden ? null : document.getElementById('banner').textContent,
      checkSide: v.checkSide,
      over: k.state.over,
      dbg: {
        turn: k.state.game.state.turn,
        human: k.state.humanSide,
        aiThinking: k.state.aiThinking,
        overBefore: overAfterRefresh,
        pieceSide: (k.state.game.state.board[idx] || {}).side,
        pieceType: (k.state.game.state.board[idx] || {}).type,
        snapIdx: (() => {
          const cell = v.snap(p.px, p.py);
          return cell ? cell.rank * 9 + cell.file : null;
        })(),
      },
    };
  })()`);

  /* ---- 1. 被将军时也能随便走（不再强制应将）---- */
  const checking = await probe([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....r....',
    '....P....',
    '....G....',
  ], 4, 9);

  await check('被将军时选中帅，有多个可走点（不再强制应将）', () => {
    if (checking.selected == null) throw new Error('没选中');
    if (checking.targets < 2) throw new Error(`可走点只有 ${checking.targets}，应 ≥2`);
  });
  await check('被将军时不会弹"送将/不能走"这类提示', () => {
    if (checking.banner && /送将|不能走/.test(checking.banner)) {
      throw new Error(`不该有这种提示: ${checking.banner}`);
    }
  });

  /* ---- 2. 送将不再是限制：真被将军时也能乱走别的子 ---- */
  const freeMove = await probe([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....r....',
    'R...G....',
  ], 0, 9);
  await check('被将军时，别的车照样能走（不过滤送将）', () => {
    if (freeMove.selected == null) throw new Error('没选中车');
    if (freeMove.targets < 1) throw new Error('车应当能走');
  });

  /* ---- 3. 几何原因走不了时才给提示 ---- */
  const blocked = await probe([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.P.P.....',
    '..E..G...',
  ], 2, 9);
  await check('象眼被塞（纯几何原因）时才给"没有落点"提示', async () => {
    if (blocked.selected == null) throw new Error('没选中; dbg=' + JSON.stringify(blocked.dbg) + ' errs=' + JSON.stringify(await pageErrs()));
    if (blocked.targets !== 0) throw new Error(`应为 0 个可走点，实际 ${blocked.targets}`);
    if (!blocked.banner) throw new Error('没有任何提示（玩家会以为棋子坏了）');
    if (/送将/.test(blocked.banner)) throw new Error(`不该提"送将": ${blocked.banner}`);
    if (!/落点/.test(blocked.banner)) throw new Error(`提示文案不对: ${blocked.banner}`);
  });

  /* ---- 4. 有可走点时不弹提示 ---- */
  const normal = await probe([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....G....',
  ], 4, 9);
  await check('有可走点时不弹任何提示', () => {
    if (normal.targets < 1) throw new Error('帅应该有可走点');
    if (normal.banner) throw new Error(`不该弹提示: ${normal.banner}`);
  });

  /* ---- 5. 被攻击时仍有红圈（纯提示，不影响能否走子）---- */
  const marked = await ev(`(() => {
    const k = window.__kards, v = k.state.view;
    const CH = {
      G: { type: 'general', side: 'red' }, g: { type: 'general', side: 'black' },
      r: { type: 'chariot', side: 'black' }, P: { type: 'pawn', side: 'red' },
    };
    const rows = ['....g....','.........','.........','.........','.........','.........','.........','....r....','....P....','....G....'];
    const board = new Array(90).fill(null);
    rows.forEach((row, r) => [...row].forEach((ch, f) => { if (ch !== '.') board[r*9+f] = { ...CH[ch] }; }));
    k.state.game.state.board = board;
    k.state.game.state.turn = 'red';
    k.state.aiThinking = false;
    k.state.over = false;
    k.refreshView({ animate: false });
    return { checkSide: v.checkSide, over: k.state.over };
  })()`);
  await check('帅被攻击时打红圈提示，但不会直接结束对局', () => {
    if (marked.checkSide !== 'red') throw new Error('checkSide=' + marked.checkSide + '，应在帅上打圈; over=' + marked.over);
    if (marked.over) throw new Error('被将军不该直接判结束');
  });

  /* ---- 6. 吃掉对方的将/帅 → 立刻结算 ---- */
  const win = await ev(`(async () => {
    const k = window.__kards, v = k.state.view;
    const CH = {
      G: { type: 'general', side: 'red' }, g: { type: 'general', side: 'black' },
      R: { type: 'chariot', side: 'red' }, P: { type: 'pawn', side: 'red' },
    };
    // 红车 (4,5) 与黑将 (4,0) 之间 (4,1)..(4,4) 全空 → 车能一路吃到将
    const rows = ['....g....','.........','.........','.........','.........','....R....','.........','.........','....P....','....G....'];
    const board = new Array(90).fill(null);
    rows.forEach((row, r) => [...row].forEach((ch, f) => { if (ch !== '.') board[r*9+f] = { ...CH[ch] }; }));
    k.state.game.state.board = board;
    k.state.game.state.turn = 'red';
    k.state.game.history = [];
    k.state.aiThinking = false;
    k.state.over = false;
    k.refreshView({ animate: false });

    const c = document.getElementById('board');
    const rect = c.getBoundingClientRect();
    const fire = (idx) => { const p = v.positionOf(idx);
      c.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: rect.left + (p.px / v.layout.width) * rect.width,
        clientY: rect.top + (p.py / v.layout.height) * rect.height,
        bubbles: true, pointerType: 'mouse' })); };
    fire(4 * 9 + 4);           // 选中红车
    await new Promise((z) => setTimeout(z, 150));
    const offered = v.targets.has(0 * 9 + 4);   // 能吃到黑将吗
    fire(0 * 9 + 4);           // 吃掉黑将
    await new Promise((z) => setTimeout(z, 700));
    return {
      offered,
      over: k.state.over,
      blackGeneral: k.state.game.state.board[0 * 9 + 4],
      banner: document.getElementById('banner').hidden ? null : document.getElementById('banner').textContent,
      resultShown: !document.getElementById('result').hidden,
    };
  })()`);
  await check('车可以吃掉对方的将（可走点里包含将所在的格）', () => {
    if (!win.offered) throw new Error('吃将的着法没出现在可走点里');
  });
  await check('吃掉将之后立刻结束并给提示', () => {
    if (!win.over) throw new Error('没有判结束');
    if (win.blackGeneral) throw new Error('黑将还在盘上');
    if (!win.banner) throw new Error('没有横幅提示');
    if (!/胜/.test(win.banner)) throw new Error(`横幅文案不对: ${win.banner}`);
  });
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  edge.kill();
  await sleep(300);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
