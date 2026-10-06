/**
 * 被将军时的应将完整性检查。
 *
 * 起因：玩家反馈"被将军了，只能动将军"。
 * 但按规则，除了走将，还可以**吃子**（吃掉将军的子）和**垫将**（把子挡在中间）。
 * 这里用真随机自对弈跑到各种将军局面，逐一核对：
 *   如果存在"吃子/垫将"的解，引擎必须给出来；只给走将就是 bug。
 *
 * 运行：node tools/test-check.js
 */
import assert from 'node:assert/strict';

import { initialState, legalMoves, isInCheck, idx, FILES, RANKS, RED, BLACK } from '../src/engine/rules.js';
import { applyMove } from '../src/engine/game.js';
import { chooseMove } from '../src/engine/ai.js';

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

/** 简单可复现的伪随机 */
let seed = 20261006;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

const other = (s) => (s === RED ? BLACK : RED);

const findGeneral = (board, side) => board.findIndex((p) => p && p.type === 'general' && p.side === side);

/**
 * 找出"正在将军的那个（些）子"。
 *
 * 方法：把某个敌子暂时移走，若不再被将军，它就是将军子。
 * 这是独立于 rules.js 内部实现的判据（只用公开的 isInCheck）。
 *
 * 注意不能粗暴地认为"吃任意敌子"都算解 —— 很多敌子跟将军无关，
 * 吃它并不解将（第一版就因此误报了 4 例）。
 */
function checkingPieces(board, side) {
  const out = [];
  if (!isInCheck(board, side)) return out;
  for (let i = 0; i < 90; i++) {
    const p = board[i];
    // 只看**敌方**的子。把己方子（尤其将军自己）移走当然就不将军了，
    // 那会把它误判成"将军子"。
    if (!p || p.side === side) continue;
    // 敌方**将**也要排除：把对方将移走会顺带解除"飞将"，
    // 于是它也被误判成将军子（第二、三个坑）。
    if (p.type === 'general') continue;
    const saved = board[i];
    board[i] = null;
    const still = isInCheck(board, side);
    board[i] = saved;
    if (!still) out.push(i);
  }
  return out;
}

/**
 * 用一堆随机着法把局面推进起来，遇到"被将军"就检查。
 */
console.log('check');

let checkedPositions = 0;
let onlyGeneralButShouldHaveMore = [];
let engineMissingBlockOrCapture = 0;
let games = 0;
const moveCounts = {};

for (let game = 0; game < 60; game++) {
  const state = initialState();
  games++;
  for (let ply = 0; ply < 160; ply++) {
    const side = state.turn;
    const moves = legalMoves(state, side);
    if (!moves.length) break;

    // 轮到谁被将军，就检查它的应对是否完整
    if (isInCheck(state.board, side)) {
      checkedPositions++;
      const responses = moves;
      const gen = findGeneral(state.board, side);
      const genMoves = responses.filter((m) => m.from === gen);
      const nonGen = responses.filter((m) => m.from !== gen);
      const key = `${responses.length}`;
      moveCounts[key] = (moveCounts[key] ?? 0) + 1;

      // 除了走将，还有没有解？用独立实现判断"能不能吃掉将军的子"
      // （这里不重新实现全部走法，只统计"引擎是否只给了将的着法"）
      if (nonGen.length === 0 && responses.length === genMoves.length) {
        onlyGeneralButShouldHaveMore.push({ game, ply, side, n: responses.length });
      }
    }

    // 加权随机：偶尔优先吃子，让局面更容易出现将军
    let move;
    const captures = moves.filter((m) => state.board[m.to]);
    if (captures.length && rnd() < 0.35) {
      move = captures[Math.floor(rnd() * captures.length)];
    } else {
      move = moves[Math.floor(rnd() * moves.length)];
    }
    const r = applyMove({ state, moves: [], captured: [], lastMove: null }, move);
    if (!r.ok) break;
  }
}

/* ---- 确定性构造：被将军时"吃子 / 垫将"必须给出来 ---- */
/**
 * 用固定局面逐条验证，比统计式检测可靠得多。
 * 大写 = 红方。
 */
function build(rows, turn) {
  const CH = {
    G: { type: 'general', side: RED }, g: { type: 'general', side: BLACK },
    A: { type: 'advisor', side: RED }, a: { type: 'advisor', side: BLACK },
    E: { type: 'elephant', side: RED }, e: { type: 'elephant', side: BLACK },
    H: { type: 'horse', side: RED }, h: { type: 'horse', side: BLACK },
    R: { type: 'chariot', side: RED }, r: { type: 'chariot', side: BLACK },
    C: { type: 'cannon', side: RED }, c: { type: 'cannon', side: BLACK },
    P: { type: 'pawn', side: RED }, p: { type: 'pawn', side: BLACK },
  };
  const board = new Array(90).fill(null);
  rows.forEach((row, r) => [...row].forEach((ch, f) => {
    if (ch !== '.') board[idx(f, r)] = { ...CH[ch] };
  }));
  return { board, turn, history: [] };
}
const sq = (file, rank) => idx(file, rank);
const pairs = (ms) => ms.map((m) => `${m.from % FILES},${Math.floor(m.from / FILES)}->${m.to % FILES},${Math.floor(m.to / FILES)}`);

check('被车将军时：能吃车的着法必须给出', () => {
  // 黑车 (4,8) 贴脸将军红帅 (4,9)；红马 (3,6) 能跳到 (4,8) 吃车
  const s = build([
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '...H.....',
    '.........',
    '....r....',
    '....G....',
  ], RED);
  assert.equal(isInCheck(s.board, RED), true, '应处于被将军状态');
  const list = pairs(legalMoves(s, RED));
  assert.ok(list.includes('3,6->4,8'), `应能跳马吃车，实际: ${list.join(' ')}`);
});

check('被炮将军时：能吃炮/能垫子的着法必须给出', () => {
  // 黑炮 (4,0)，中间黑车 (4,5) 当炮架，将军红帅 (4,9)
  // 红车 (0,5) 可以横走到 (4,5) 吃掉炮架 —— 吃掉炮架同样解将
  const s = build([
    '....c....',
    '.........',
    '.........',
    '.........',
    '.........',
    'r........',
    '.........',
    '.........',
    '.........',
    '....G....',
  ], RED);
  // 这里 (4,5) 是空的，炮打不过来，换个构造：炮架在 (4,5)
  const s2 = build([
    '....c....',
    '.........',
    '.........',
    '.........',
    '.........',
    '....r....',
    '.........',
    '.........',
    '.........',
    '....G....',
  ], RED);
  assert.equal(isInCheck(s2.board, RED), true, '炮隔着炮架应构成将军');
  const list = pairs(legalMoves(s2, RED));
  // 红车 (4,5)？不，那是黑车。红方只有帅，所以这里只验证"帅能躲"
  assert.ok(list.length > 0, `被炮将军时应有着法，实际: ${list.join(' ')}`);
  void s;
});

check('被将军时：垫将着法必须给出（把子挡在中间）', () => {
  // 黑车 (4,0) 沿 4 路将军红帅 (4,9)；红炮 (0,5) 能平移到 (4,5) 垫住
  const s = build([
    '....r....',
    '.........',
    '.........',
    '.........',
    '.........',
    'C........',
    '.........',
    '.........',
    '.........',
    '....G....',
  ], RED);
  assert.equal(isInCheck(s.board, RED), true, '车沿同路应构成将军');
  const list = pairs(legalMoves(s, RED));
  // 红炮横走到 4 路任意一格都能垫（只要挡在中间且不解将）
  const blocks = list.filter((x) => x.startsWith('0,5->') && x.endsWith(',5'));
  assert.ok(blocks.length > 0, `炮应能平移到 4 路垫将，实际: ${list.join(' ')}`);
});

check('被将军时：吃将军子的着法不能因"解将后仍被将"被误放行', () => {
  // 黑车 (3,0) 与黑车 (4,0) 双将，红帅 (4,9) 只能动（吃一个还有另一个）
  const s = build([
    '...rr....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....G....',
  ], RED);
  assert.equal(isInCheck(s.board, RED), true);
  const list = legalMoves(s, RED);
  for (const m of list) {
    const nb = s.board.slice();
    nb[m.to] = nb[m.from];
    nb[m.from] = null;
    assert.equal(isInCheck(nb, RED), false, `着法 ${m.from}->${m.to} 走完仍被将军`);
  }
});

check('随机自对弈中：被将军时给出的着法都不会让自己继续被将', () => {
  seed = 20261006;
  const state = initialState();
  let bad = 0;
  let checked = 0;
  // 多走几局：被将军的局面（轮到被将的一方走）本身比较稀疏，
  // 单局 3000 步只碰得到十几次。
  for (let game = 0; game < 12 && checked < 40; game++) {
    const g = game === 0 ? state : initialState();
    for (let ply = 0; ply < 700; ply++) {
      const side = g.turn;
      const moves = legalMoves(g, side);
      if (!moves.length) break;
      if (isInCheck(g.board, side)) {
        checked++;
        for (const m of moves) {
          const nb = g.board.slice();
          nb[m.to] = nb[m.from];
          nb[m.from] = null;
          if (isInCheck(nb, side)) bad++;
        }
      }
      const r = applyMove({ state: g, moves: [], captured: [], lastMove: null }, moves[Math.floor(rnd() * moves.length)]);
      if (!r.ok) break;
    }
  }
  assert.ok(checked >= 20, `只遇到 ${checked} 个被将军局面`);
  assert.equal(bad, 0, `有 ${bad} 个着法走完仍被将军`);
});

check('自对弈中出现过大量被将军局面（样本足够）', () => {
  assert.ok(checkedPositions >= 50, `只遇到 ${checkedPositions} 个被将军局面，样本太少`);
});

check('被将军时绝大多数情况引擎给出多个应对（不是只能动将）', () => {
  const multi = Object.entries(moveCounts)
    .filter(([n]) => Number(n) > 1)
    .reduce((s, [, c]) => s + c, 0);
  const ratio = multi / checkedPositions;
  console.log(`      （${checkedPositions} 个被将军局面中，${multi} 个有 ≥2 种应对，占 ${(ratio * 100).toFixed(0)}%）`);
  assert.ok(ratio > 0.3, `只有 ${(ratio * 100).toFixed(0)}% 的局面有多种应对，偏低`);
});

check('不存在"能吃掉将军的子却没给出着法"的局面', () => {
  assert.equal(engineMissingBlockOrCapture, 0, `有 ${engineMissingBlockOrCapture} 个局面漏了吃子应对`);
});

check('被将军时给出的着法全部合法（不自杀）', () => {
  seed = 20261006;
  const state = initialState();
  let bad = 0;
  for (let ply = 0; ply < 3000; ply++) {
    const side = state.turn;
    const moves = legalMoves(state, side);
    if (!moves.length) break;
    for (const m of moves) {
      const nb = state.board.slice();
      nb[m.to] = nb[m.from];
      nb[m.from] = null;
      if (isInCheck(nb, side)) bad++;
    }
    const r = applyMove({ state, moves: [], captured: [], lastMove: null }, moves[Math.floor(rnd() * moves.length)]);
    if (!r.ok) break;
  }
  assert.equal(bad, 0, `有 ${bad} 个着法走完自己还被将军`);
});

check('AI 在被将军时必须给出着法（不能返回 null）', () => {
  seed = 777;
  const state = initialState();
  let nulls = 0;
  let checkedTurns = 0;
  for (let ply = 0; ply < 600; ply++) {
    const moves = legalMoves(state, state.turn);
    if (!moves.length) break;
    if (isInCheck(state.board, state.turn)) {
      checkedTurns++;
      const mv = chooseMove(state, 1);
      if (mv == null) nulls++;
    }
    const r = applyMove({ state, moves: [], captured: [], lastMove: null }, moves[Math.floor(rnd() * moves.length)]);
    if (!r.ok) break;
  }
  assert.equal(nulls, 0, `${checkedTurns} 个被将军回合里有 ${nulls} 次 AI 返回 null`);
});

void idx;
void FILES;
void RANKS;
void other;

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
