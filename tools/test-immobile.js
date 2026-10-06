/**
 * "选中了但没有可走点"的成因核查。
 *
 * 用户反馈：我的回合想走象，走不了（选中了但没有可走点）。
 * 猜测：走象之后会被将军（比如隔壁的炮/车顺势将军），于是该着法被过滤，
 *       表现为"这只子完全动不了"。
 *
 * 这里构造几种局面，核对引擎的行为：
 *   A. 走象会自将 → 该着法应被滤掉（正确）
 *   B. 象眼被占 → 象不能动（正确）
 *   C. 象只能往一侧走（另一侧会自将）→ 应当**只滤掉一侧**，而不是整只子
 *   D. 被将军时，能挡/能吃的着法必须保留
 *
 * 运行：node tools/test-immobile.js
 */
import assert from 'node:assert/strict';
import { legalMoves, isInCheck, idx, initialState, RED, BLACK } from '../src/engine/rules.js';
import { applyMove, createGame } from '../src/engine/game.js';

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

const CH = {
  G: { type: 'general', side: RED }, g: { type: 'general', side: BLACK },
  A: { type: 'advisor', side: RED }, a: { type: 'advisor', side: BLACK },
  E: { type: 'elephant', side: RED }, e: { type: 'elephant', side: BLACK },
  H: { type: 'horse', side: RED }, h: { type: 'horse', side: BLACK },
  R: { type: 'chariot', side: RED }, r: { type: 'chariot', side: BLACK },
  C: { type: 'cannon', side: RED }, c: { type: 'cannon', side: BLACK },
  P: { type: 'pawn', side: RED }, p: { type: 'pawn', side: BLACK },
};

/** 用 10 行 9 列的画法建局面（第 0 行是最上面 = 黑方底线） */
function build(rows, turn) {
  const board = new Array(90).fill(null);
  rows.forEach((row, r) => [...row].forEach((ch, f) => {
    if (ch !== '.') board[idx(f, r)] = { ...CH[ch] };
  }));
  return { board, turn, history: [] };
}

const sq = (f, r) => idx(f, r);
const at = (state, f, r) => state.board[sq(f, r)];
const movesOf = (state, f, r) => legalMoves(state, state.turn)
  .filter((m) => m.from === sq(f, r))
  .map((m) => `${m.to % 9},${Math.floor(m.to / 9)}`);

console.log('immobile');

/* ---------- A：走象会露出帅（自将）→ 该着法被滤掉 ---------- */
check('A. 走象会让己方被将军时，这个着法被滤掉（正确行为）', () => {
  // 黑车在 (0,4)，红帅在 (0,9)？——车沿 0 路直下会将军，
  // 中间放一个红象 (0,7) 挡着。象一动，车就将军。
  const st = build([
    '....g....',
    '.........',
    '.........',
    '.........',
    'r........',
    '.........',
    '.........',
    'E........',
    '.........',
    'G........',
  ], RED);
  assert.equal(isInCheck(st.board, RED), false, '局面本身不应被将军');
  const ms = movesOf(st, 0, 7);
  // 象在 (0,7)：可走 (2,5)(2,9)，但两个都会让 0 路空出来 → 车将军 → 被滤掉
  assert.deepEqual(ms, [], `象应当完全无法移动（走哪边都会被将军），实际: ${ms.join(' ')}`);
});

/* ---------- B：象眼被占 ---------- */
check('B. 象眼被占时该方向不能走', () => {
  const st = build([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '..E..G...',
  ], RED);
  // 红象 (2,9)：可走 (0,7) 与 (4,7)
  const ms = movesOf(st, 2, 9);
  assert.deepEqual(ms.sort(), ['0,7', '4,7'].sort(), `实际: ${ms.join(' ')}`);

  // 占住 (3,8) 这个象眼 → (4,7) 不能走了
  const st2 = build([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '...P.....',
    '..E..G...',
  ], RED);
  const ms2 = movesOf(st2, 2, 9);
  assert.deepEqual(ms2, ['0,7'], `(3,8) 有子后只能走 (0,7)，实际: ${ms2.join(' ')}`);
});

/* ---------- C：独立判据 —— 引擎不该把"按规则能走"的着法漏掉 ---------- */
check('C. 随机局面下，按规则算得出的着法，引擎必须给出来（不漏）', () => {
  /*
   * 用一套**独立于引擎**的判据重新算一遍：
   *   - 象：对角两格、不过河、象眼必须空
   *   - 士：斜一格、不出九宫
   * 再逐个判断"走完之后自己会不会被将军"（用公开的 isInCheck 判断，
   * 这一层不算作弊，因为被将军的定义本身就是规则）。
   * 只要有一个着法满足全部条件，引擎就必须给出至少一个。
   */
  const ref = (board, side, from) => {
    const p = board[from];
    if (!p) return [];
    const f = from % 9;
    const r = Math.floor(from / 9);
    const out = [];
    const steps = p.type === 'elephant'
      ? [[2, 2], [2, -2], [-2, 2], [-2, -2]]
      : p.type === 'advisor'
        ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
        : [];
    for (const [df, dr] of steps) {
      const nf = f + df;
      const nr = r + dr;
      if (nf < 0 || nf > 8 || nr < 0 || nr > 9) continue;
      if (p.type === 'elephant') {
        if (side === RED && nr < 5) continue;   // 不过河
        if (side === BLACK && nr > 4) continue;
        if (board[idx(f + df / 2, r + dr / 2)]) continue; // 塞象眼
      } else {
        if (nf < 3 || nf > 5) continue;         // 不出九宫
        if (side === RED ? nr < 7 : nr > 2) continue;
      }
      const target = board[idx(nf, nr)];
      if (target && target.side === side) continue;
      const nb = board.slice();
      nb[idx(nf, nr)] = nb[from];
      nb[from] = null;
      if (isInCheck(nb, side)) continue;        // 走完不能自己被将
      out.push(idx(nf, nr));
    }
    return out;
  };

  let seed = 987654;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const st = initialState();
  const game = { state: st, moves: [], captured: [], lastMove: null };

  let checked = 0;
  const missed = [];

  for (let ply = 0; ply < 5000; ply++) {
    const side = st.turn;
    const all = legalMoves(st, side);
    if (!all.length) break;

    for (let i = 0; i < 90; i++) {
      const p = st.board[i];
      if (!p || p.side !== side) continue;
      if (p.type !== 'elephant' && p.type !== 'advisor') continue;
      checked++;
      const want = ref(st.board, side, i);
      const got = all.filter((m) => m.from === i).map((m) => m.to);
      if (want.length && !got.length) {
        missed.push(`ply${ply} ${side}${p.type}@${i % 9},${Math.floor(i / 9)} 规则上可走 ${want.map((x) => `${x % 9},${Math.floor(x / 9)}`).join(' ')}，引擎一个都没给`);
      }
    }

    const mv = all[Math.floor(rnd() * all.length)];
    const res = applyMove(game, mv);
    if (!res.ok) break;
  }

  console.log(`      （核对了 ${checked} 个象/士的着法集合，漏给 ${missed.length} 次）`);
  if (missed.length) console.log(`      ${missed.slice(0, 3).join(' | ')}`);
  assert.ok(checked > 500, `只核对了 ${checked} 个，样本太少`);
  assert.equal(missed.length, 0, `有 ${missed.length} 次按规则能走却没给出来`);
});

/* ---------- D：被将军时能挡/能吃的着法必须保留 ---------- */
check('D. 被将军时，能挡住/能吃掉将军子的着法必须保留', () => {
  // 黑车 (4,0) 沿 4 路将军红帅 (4,9)；红象若在 (2,5) 且能走到 (4,3) 挡？
  // 象走对角，挡不了直线。改用红炮 (0,3) 平移到 4 路挡。
  const st = build([
    '....r....',
    '.........',
    '.........',
    'C........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....G....',
  ], RED);
  assert.equal(isInCheck(st.board, RED), true);
  const ms = legalMoves(st, RED);
  const blocks = ms.filter((m) => m.from === sq(0, 3) && m.to % 9 === 4);
  assert.ok(blocks.length > 0, `炮应当能平移到 4 路垫将，实际: ${ms.map((m) => `${m.from}->${m.to}`).join(' ')}`);
});

/* ---------- E：开局时每只象都有走法（回归） ---------- */
check('E. 开局时四只象都能走（每只 2 步）', () => {
  const st = initialState();
  let n = 0;
  for (let i = 0; i < 90; i++) {
    const p = st.board[i];
    if (!p || p.type !== 'elephant') continue;
    n++;
    const ms = legalMoves(st, p.side).filter((m) => m.from === i);
    assert.equal(ms.length, 2, `${p.side} 象 @${i % 9},${Math.floor(i / 9)} 只有 ${ms.length} 步`);
  }
  assert.equal(n, 4, `开局的象数量应为 4，实际 ${n}`);
});

/* ---------- F：全盘扫描"完全动不了的子"，看是否合理 ---------- */
check('F. 开局局面里没有任何己方棋子应该是完全动不了的', () => {
  const st = initialState();
  const stuck = [];
  for (let i = 0; i < 90; i++) {
    const p = st.board[i];
    if (!p) continue;
    const ms = legalMoves(st, p.side).filter((m) => m.from === i);
    if (!ms.length) stuck.push(`${p.side}${p.type}@${i % 9},${Math.floor(i / 9)}`);
  }
  assert.deepEqual(stuck, [], `这些子开局就动不了: ${stuck.join(' ')}`);
});

/* ---------- G：随机对局里统计"动作但动不了"的子，并核对是否都有正当原因 ---------- */
check('G. 随机对局中"动不了"的己方子，必须确实各有原因（象眼/不过河/自将）', () => {
  let seed = 424242;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const st = initialState();
  const game = { state: st, moves: [], captured: [], lastMove: null };
  let samples = 0;
  let suspicious = 0;
  const detail = [];

  for (let ply = 0; ply < 4000; ply++) {
    const side = st.turn;
    const all = legalMoves(st, side);
    if (!all.length) break;

    // 只统计象/士这类"活动范围小"的子
    for (let i = 0; i < 90; i++) {
      const p = st.board[i];
      if (!p || p.side !== side) continue;
      if (p.type !== 'elephant' && p.type !== 'advisor') continue;
      const ms = all.filter((m) => m.from === i);
      if (ms.length) continue;
      samples++;
      // 动不了的原因只可能是：四个对角/斜角全部不合法（出界、过河、象眼被占、自将）
      // 这里用一个独立判断：把它挪到任意合法对角格，看是否"走完被将"
      const f = i % 9;
      const r = Math.floor(i / 9);
      const steps = p.type === 'elephant'
        ? [[2, 2], [2, -2], [-2, 2], [-2, -2]]
        : [[1, 1], [1, -1], [-1, 1], [-1, -1]];
      let legalByGeometry = 0;
      let blockedBySelfCheckOnly = 0;
      for (const [df, dr] of steps) {
        const nf = f + df;
        const nr = r + dr;
        if (nf < 0 || nf > 8 || nr < 0 || nr > 9) continue;
        // 象不过河
        if (p.type === 'elephant') {
          if (p.side === RED && nr < 5) continue;
          if (p.side === BLACK && nr > 4) continue;
        }
        // 士不出九宫
        if (p.type === 'advisor') {
          const inPalace = nf >= 3 && nf <= 5 && (p.side === RED ? nr >= 7 : nr <= 2);
          if (!inPalace) continue;
        }
        // 象眼
        if (p.type === 'elephant') {
          const eye = idx(f + df / 2, r + dr / 2);
          if (st.board[eye]) continue;
        }
        const target = st.board[idx(nf, nr)];
        if (target && target.side === side) continue;
        legalByGeometry++;
        // 走完是否被将
        const nb = st.board.slice();
        nb[idx(nf, nr)] = nb[i];
        nb[i] = null;
        if (isInCheck(nb, side)) blockedBySelfCheckOnly++;
      }
      if (legalByGeometry > 0 && blockedBySelfCheckOnly < legalByGeometry) {
        suspicious++;
        if (detail.length < 3) {
          detail.push(`ply${ply} ${p.side}${p.type}@${f},${r} 几何合法${legalByGeometry} 被自将挡${blockedBySelfCheckOnly}`);
        }
      }
    }

    const mv = all[Math.floor(rnd() * all.length)];
    const res = applyMove(game, mv);
    if (!res.ok) break;
  }

  console.log(`      （扫到 ${samples} 个"动不了的象/士"，其中可疑 ${suspicious} 个）`);
  if (detail.length) console.log(`      ${detail.join(' | ')}`);
  assert.equal(suspicious, 0, `有 ${suspicious} 个局面里象/士明明有几何合法着法却完全没给出`);
});

void createGame;
void at;

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
