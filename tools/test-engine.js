/**
 * 引擎回归测试：规则 + 搜索。
 * 运行：node tools/test-engine.js
 */
import assert from 'node:assert/strict';

import {
  BLACK,
  RED,
  FILES,
  RANKS,
  initialState,
  isInCheck,
  legalMoves,
  gameStatus,
  pseudoMoves,
  generalsFace,
  idx,
} from '../src/engine/rules.js';
import { chooseMove, LEVELS, evaluate } from '../src/engine/ai.js';

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

/** 用简写搭局面：'R'红车 'r'黑车 'G'红帅 'g'黑将 ... */
const CH = {
  G: { type: 'general', side: RED }, A: { type: 'advisor', side: RED }, E: { type: 'elephant', side: RED },
  H: { type: 'horse', side: RED }, R: { type: 'chariot', side: RED }, C: { type: 'cannon', side: RED },
  P: { type: 'pawn', side: RED },
  g: { type: 'general', side: BLACK }, a: { type: 'advisor', side: BLACK }, e: { type: 'elephant', side: BLACK },
  h: { type: 'horse', side: BLACK }, r: { type: 'chariot', side: BLACK }, c: { type: 'cannon', side: BLACK },
  p: { type: 'pawn', side: BLACK },
};

function position(rows, turn = RED) {
  const board = new Array(FILES * RANKS).fill(null);
  rows.forEach((row, r) => {
    [...row.replace(/ /g, '')].forEach((ch, f) => {
      if (ch !== '.') board[idx(f, r)] = { ...CH[ch] };
    });
  });
  return { board, turn, history: [] };
}

console.log('engine · 规则');

check('棋盘为 9 路 × 10 线', () => {
  assert.equal(FILES, 9);
  assert.equal(RANKS, 10);
});

check('初始局面共 32 子，双方各 16', () => {
  const s = initialState();
  const pieces = s.board.filter(Boolean);
  assert.equal(pieces.length, 32);
  assert.equal(pieces.filter((p) => p.side === RED).length, 16);
  assert.equal(pieces.filter((p) => p.side === BLACK).length, 16);
  const byType = (side, t) => pieces.filter((p) => p.side === side && p.type === t).length;
  for (const side of [RED, BLACK]) {
    assert.equal(byType(side, 'general'), 1);
    assert.equal(byType(side, 'advisor'), 2);
    assert.equal(byType(side, 'elephant'), 2);
    assert.equal(byType(side, 'horse'), 2);
    assert.equal(byType(side, 'chariot'), 2);
    assert.equal(byType(side, 'cannon'), 2);
    assert.equal(byType(side, 'pawn'), 5);
  }
});

check('红方开局合法着法为 44 步（标准值）', () => {
  const s = initialState();
  assert.equal(legalMoves(s, RED).length, 44);
  assert.equal(legalMoves(s, BLACK).length, 44);
});

check('开局无将军、无胜负', () => {
  const s = initialState();
  assert.equal(isInCheck(s.board, RED), false);
  assert.equal(isInCheck(s.board, BLACK), false);
  assert.equal(gameStatus(s).over, false);
});

check('马走日、蹩马腿', () => {
  // 红马在 (4,5)，周围空 → 8 个落点
  const a = position(['.........', '.........', '.........', '.........', '.........',
    '....H....', '.........', '.........', '....g....', '....G....']);
  const targets = pseudoMoves(a, RED).filter((m) => m.from === idx(4, 5)).map((m) => m.to);
  assert.equal(targets.length, 8, `马应有 8 个落点，实际 ${targets.length}`);

  // 在马腿 (4,4) 放一个子：沿"较大位移轴"经过 (4,4) 的四步被蹩，
  // 剩 (±2,±1) 方向的四步 → 加上吃掉不了己方子，共 6 个落点
  const b = position(['.........', '.........', '.........', '.........', '....P....',
    '....H....', '.........', '.........', '....g....', '....G....']);
  const t2 = pseudoMoves(b, RED).filter((m) => m.from === idx(4, 5)).map((m) => m.to).sort((x, y) => x - y);
  const expect = [idx(2, 4), idx(6, 4), idx(2, 6), idx(6, 6), idx(3, 7), idx(5, 7)].sort((x, y) => x - y);
  assert.deepEqual(t2, expect, `蹩马腿后落点不符: ${t2.map((i) => `${i % 9},${Math.floor(i / 9)}`)}`);

  // 再把 (5,5) 也堵上：剩 (±2,±1) 中朝右的两步被蹩 → 4 个落点
  b.board[idx(5, 5)] = { type: 'pawn', side: RED };
  const t3 = pseudoMoves(b, RED).filter((m) => m.from === idx(4, 5)).map((m) => m.to);
  assert.equal(t3.length, 4, `两处马腿后应剩 4 个落点，实际 ${t3.length}`);
});

check('象走田、塞象眼、不过河', () => {
  const a = position(['.........', '.........', '.........', '.........', '.........',
    '.........', '.........', '....E....', '.........', '....G....',
  ]);
  a.board[idx(4, 7)] = { type: 'elephant', side: RED };
  a.board[idx(4, 9)] = { type: 'general', side: RED };
  a.board[idx(4, 0)] = { type: 'general', side: BLACK };
  const t = pseudoMoves(a, RED).filter((m) => m.from === idx(4, 7)).map((m) => m.to);
  assert.equal(t.length, 4, `象应有 4 个落点，实际 ${t.length}`);
  // 全部落在红方半场（rank >= 5）
  for (const to of t) assert.ok(Math.floor(to / 9) >= 5, '象不能过河');
  // 塞象眼
  a.board[idx(5, 6)] = { type: 'pawn', side: RED };
  const t2 = pseudoMoves(a, RED).filter((m) => m.from === idx(4, 7)).map((m) => m.to);
  assert.equal(t2.length, 3, `塞象眼后应剩 3 个落点，实际 ${t2.length}`);
});

check('炮：空走同车，吃子必须炮打隔子', () => {
  const s = position([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '....C....',
    '.........',
    '..r......',
    '.........',
    '....G....',
  ]);
  // 炮在 (4,5)：纵向空走到 (4,0..4) 与 (4,6..9)，但不能吃 (4,0) 的将（中间无架）
  const t = pseudoMoves(s, RED).filter((m) => m.from === idx(4, 5)).map((m) => m.to);
  assert.ok(!t.includes(idx(4, 0)), '炮不能无架吃将');
  // 加一个炮架
  s.board[idx(4, 3)] = { type: 'pawn', side: RED };
  const t2 = pseudoMoves(s, RED).filter((m) => m.from === idx(4, 5)).map((m) => m.to);
  assert.ok(t2.includes(idx(4, 0)), '有架时炮应能吃将');
});

check('兵/卒：过河前只能直走，过河后可横走', () => {
  const s = position([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '....P....',   // 未过河（红方 rank 5）
    '.........',
    '.........',
    '.........',
    '....G....',
  ]);
  const before = pseudoMoves(s, RED).filter((m) => m.from === idx(4, 5)).map((m) => m.to);
  assert.deepEqual(before, [idx(4, 4)], '未过河的兵只能前进一步');
  s.board[idx(4, 4)] = s.board[idx(4, 5)];
  s.board[idx(4, 5)] = null;
  const after = pseudoMoves(s, RED).filter((m) => m.from === idx(4, 4)).map((m) => m.to).sort((a, b) => a - b);
  assert.deepEqual(after, [idx(3, 4), idx(4, 3), idx(5, 4)].sort((a, b) => a - b), '过河后可横走');
});

check('士/帅不能出九宫', () => {
  const s = position([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....A....',
    '.........',
    '....G....',
  ]);
  const tA = pseudoMoves(s, RED).filter((m) => m.from === idx(4, 7)).map((m) => m.to);
  for (const to of tA) {
    const f = to % 9;
    const r = Math.floor(to / 9);
    assert.ok(f >= 3 && f <= 5 && r >= 7 && r <= 9, `士出九宫了: ${f},${r}`);
  }
  const tG = pseudoMoves(s, RED).filter((m) => m.from === idx(4, 9)).map((m) => m.to);
  for (const to of tG) {
    const f = to % 9;
    const r = Math.floor(to / 9);
    assert.ok(f >= 3 && f <= 5 && r >= 7 && r <= 9, `帅出九宫了: ${f},${r}`);
  }
});

console.log('engine · 将帅与胜负');

check('将帅照面判定正确', () => {
  const facing = position(['....g....', '.........', '.........', '.........', '.........',
    '.........', '.........', '.........', '.........', '....G....']);
  assert.equal(generalsFace(facing.board), true, '同一直线且中间无子应照面');
  facing.board[idx(4, 5)] = { type: 'pawn', side: RED };
  assert.equal(generalsFace(facing.board), false, '中间有子则不照面');
});

check('飞将属于非法着法（走后自将）', () => {
  // 红车在 (0,5)，黑将在 (4,0)，红帅 (4,9)，中间只有黑将和红帅之间空
  const s = position([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    'R........',
    '.........',
    '.........',
    '.........',
    '....G....',
  ]);
  // 红方此时已照面：红车不在中间，直接用帅判定
  assert.equal(isInCheck(s.board, RED), true, '照面应视为被将军');
});

check('被将军时只能走应将着法', () => {
  const s = position([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '..r......',
    '....G....',
  ], RED);
  // 黑车在 (2,8) 横向吃将：(2,8) -> (3,8) -> (4,8) 不，将在 (4,9)，车在 (2,8) 不构成将军
  s.board[idx(4, 8)] = { type: 'chariot', side: BLACK };
  const checked = isInCheck(s.board, RED);
  assert.equal(checked, true, '黑车在帅正上方应将军');
  const legal = legalMoves(s, RED);
  for (const m of legal) {
    const b = s.board.slice();
    b[m.to] = b[m.from];
    b[m.from] = null;
    assert.equal(isInCheck(b, RED), false, '合法着法不应仍被将军');
  }
});

check('将死判定：车在九宫口将军，两翼被封', () => {
  // 黑将在 (4,0)：红车 (4,1) 贴身将军；(0,0) 与 (8,0) 两个红车封住两翼退路
  const s = position([
    'R...g...R',
    '....R....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....G....',
  ], BLACK);
  assert.equal(isInCheck(s.board, BLACK), true, '黑将应被将军');
  assert.equal(legalMoves(s, BLACK).length, 0, '黑方应无子可走');
  const st = gameStatus(s);
  assert.equal(st.over, true, '应判定结束');
  assert.equal(st.winner, RED, `应红方获胜，实际 ${st.winner} / ${st.reason}`);
  assert.equal(st.reason, 'checkmate');
});

check('困毙（无子可走但未被将军）也判负', () => {
  // 黑将 (4,0) 未被将军，三个落点分别被控制：
  //   (3,0) ← 红车 R(3,3) 沿第 3 路直上
  //   (4,1) ← 红相 E(4,2) 的"田"字（象眼 (3,3)/(5,3) 之一为空即可，这里 (5,3) 空）
  //   (5,0) ← 红马 H(6,2) 的"日"字（马腿 (6,1) 空）
  // 同时 E(4,2) 正好挡住第 4 路，避免将帅照面。
  const s = position([
    '....g....',
    '.........',
    '....E.H..',
    '...R.....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....G....',
  ], BLACK);
  assert.equal(isInCheck(s.board, BLACK), false, '这局面不应被将军');
  const remaining = legalMoves(s, BLACK);
  assert.equal(remaining.length, 0, `黑方应无子可走，实际 ${remaining.length} 步`);
  const st = gameStatus(s);
  assert.equal(st.over, true, '困毙应判结束');
  assert.equal(st.reason, 'stalemate');
  assert.equal(st.winner, RED);
});

console.log('engine · 搜索');

check('过河兵横吃必须相邻一路（远处同排不构成将军）', () => {
  // 黑卒在 (0,9)，红帅在 (4,9)：同排、中间无子，但相距 4 路
  const far = position([
    '...g.....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    'p...G....',
  ], RED);
  assert.equal(isInCheck(far.board, RED), false, '相距 4 路的过河卒不应构成将军');
  assert.equal(gameStatus(far).reason, 'normal', '不应被判为被将军');
  const moves = legalMoves(far, RED).map((m) => m.to);
  // (5,9) 和 (4,8) 是逃格；(3,9) 不行 —— 那会让红帅和黑将同在 3 路（飞将）
  assert.ok(moves.includes(idx(5, 9)), '右侧逃格 (5,9) 被吞掉了');
  assert.ok(moves.includes(idx(4, 8)), '前方逃格 (4,8) 被吞掉了');

  // 紧邻一路的过河兵必须仍然构成将军：黑卒 (3,9) 横吃红帅 (4,9)
  const near = position([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '...pG....',
  ], RED);
  assert.equal(isInCheck(near.board, RED), true, '相邻一路的过河兵应构成将军');
});

check('假将军不会导致假将死（曾经会错判胜负）', () => {
  // 黑车 (4,7) 真将军；黑卒在 (0,9) 是远距离"假将军"
  const s = position([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....r....',
    '.........',
    'p...G....',
  ], RED);
  const targets = legalMoves(s, RED).map((m) => m.to);
  assert.ok(
    targets.includes(idx(5, 9)) || targets.includes(idx(3, 9)) || targets.includes(idx(4, 8)),
    `红帅应有逃格，实际可走: ${targets.map((i) => `${i % 9},${Math.floor(i / 9)}`)}`,
  );
  assert.equal(gameStatus(s).over, false, '不应被判将死');
});

check('引擎能在 1 步吃掉白送的车', () => {
  const s = position([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '....R....',
    '....r....',
    '.........',
    '.........',
    '....G....',
  ], RED);
  const mv = chooseMove(s, { id: 2, name: 't', depth: 3, timeMs: 400, random: 0 });
  assert.ok(mv, '应给出着法');
  assert.equal(mv.from, idx(4, 5), '应走车');
  assert.equal(mv.to, idx(4, 6), '应吃掉黑车');
});

check('四档配置齐全且都能在时限内出招', () => {
  assert.ok(LEVELS.length >= 3);
  const s = initialState();
  for (const lv of LEVELS) {
    const t0 = Date.now();
    const mv = chooseMove(s, { ...lv, random: 0 });
    const dt = Date.now() - t0;
    assert.ok(mv, `档位 ${lv.name} 未出招`);
    assert.ok(dt <= lv.timeMs + 1500, `档位 ${lv.name} 超时: ${dt}ms`);
    console.log(`      · ${lv.name} 用时 ${dt}ms`);
  }
});

check('评估函数对子力优势给出正分', () => {
  const even = initialState();
  assert.equal(Math.round(evaluate(even, RED)), Math.round(evaluate(even, BLACK)));
  const s = initialState();
  s.board[idx(0, 0)] = null; // 拿走黑方一个车
  assert.ok(evaluate(s, RED) > 0, '红方多一车应为正分');
});

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
