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
  isAttacked,
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

/*
 * ⚠️ 从这里开始是**本项目特意改过的规则**（用户要求踹掉"不允许送将"）。
 *
 * 旧规则：不能走送将的着法 → 被将军只能应将 → 将死/困毙判负。
 * 新规则：任何子都能随便走 → **吃掉对方的将/帅才赢** → 没有将死、没有困毙判负。
 *
 * 所以下面这些断言的预期完全反过来了。
 */
check('送将着法不再被过滤（被将军时也能随便走）', () => {
  /*
   * 用一个真正"牵制"的局面：黑车 (0,4) 沿 0 路盯着红帅… 不，帅在 (4,9)。
   * 改成：黑车 (0,9) 与红帅 (4,9) 同一横线，中间 (2,9) 放一个红马挡着。
   * 马一动，底线就通 → 帅被车吃。旧规则下这匹马一步都不能走；
   * 新规则下它随便走（走了就等着被吃帅）。
   */
  const s = position([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    'r.H.G....',
  ], RED);
  const horse = idx(2, 9);
  const legal = legalMoves(s, RED);
  const horseMoves = legal.filter((m) => m.from === horse);
  assert.ok(horseMoves.length > 0, '新规则下这匹马应当能走（旧规则下是 0 步）');

  // 走完确实会被攻击 —— 但引擎不再因此拒绝
  const after = s.board.slice();
  const m0 = horseMoves[0];
  after[m0.to] = after[m0.from];
  after[m0.from] = null;
  assert.equal(isAttacked(after, RED), true, '这匹马走开后帅确实会被车吃（牵制）');
});

check('吃掉对方的将/帅即获胜（唯一的取胜方式）', () => {
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
    '....G....',
  ], RED);
  // 黑车 (4,7) 与红帅 (4,9) 之间 (4,8) 空 → 车能一路吃到帅
  const canEat = legalMoves(s, RED).some((m) => m.to === idx(4, 7))
    || legalMoves(s, BLACK).some((m) => m.to === idx(4, 9));
  assert.equal(canEat, true, '应当存在吃掉对方将/帅的着法');

  // 直接把红帅拿掉，模拟"被吃了"
  const b = s.board.slice();
  b[idx(4, 9)] = null;
  const st = gameStatus({ board: b, turn: BLACK, history: [] });
  assert.equal(st.over, true, '帅被吃应判定结束');
  assert.equal(st.winner, BLACK, `应黑方获胜，实际 ${st.winner}`);
  assert.equal(st.reason, 'general-captured');
});

check('没有"将死"这一说：帅还在就继续下', () => {
  // 旧测试里的"将死"局面，现在不应该判结束
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
  assert.equal(isAttacked(s.board, BLACK), true, '黑将仍被红车攻击');
  // 新规则：被攻击也能走，所以绝不该出现"无着可走"
  assert.ok(legalMoves(s, BLACK).length > 0, '新规则下黑方不可能是零着法');
  const st = gameStatus(s);
  assert.equal(st.reason, 'check', `应当只是"被将"，实际 ${st.reason}`);
  // 黑将可以直接吃掉贴身的红车
  assert.ok(
    legalMoves(s, BLACK).some((m) => m.from === idx(4, 0) && m.to === idx(4, 1)),
    '黑将应当能吃掉贴身的红车',
  );
});

check('没有"困毙判负"：无子可走也不结束', () => {
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
  // 去掉"送将过滤"后，黑将总能乱走，所以永不为零
  assert.ok(legalMoves(s, BLACK).length > 0, '新规则下黑方总有得走');
  const st = gameStatus(s);
  assert.equal(st.over, false, '不应当判结束（没有困毙判负）');
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
  /*
   * ⚠️ 改规则后这里要**封住 4 路**：红车在 (4,5)、黑车在 (4,6)、黑将在 (4,0)、
   * 红帅在 (4,9)。4 路一旦畅通，红车可以直接 4,5→4,9 把黑将吃掉，
   * AI 当然选赢棋而不是吃车（第一版就是这么"失败"的）。
   * 在 (4,2) 与 (4,8) 各放一个自己的兵，把 4 路隔断，只看吃车。
   */
  const s = position([
    '....g....',
    '.........',
    '....P....',
    '.........',
    '.........',
    '....R....',
    '....r....',
    '.........',
    '....P....',
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
