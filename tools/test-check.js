/**
 * 被将军时的着法集合 —— **按本项目改过的规则**。
 *
 * ⚠️ 用户明确要求踹掉"不允许送将"这条规则：正常模式下任何子都能走，
 * 吃掉对方的将/帅才算赢。
 *
 * 所以这份测试的取向和常规象棋测试**相反**：
 *   - 不再断言"被将军时只能走应将着法"
 *   - 而是断言：不过滤送将、帅能被吃、吃掉即胜、且引擎不会因此崩
 *
 * 走法生成本身的正确性在 test-engine.js 与 test-immobile.js 里覆盖
 * （那两份用"独立判据"核对的是走法几何，与胜负规则无关）。
 *
 * 运行：node tools/test-check.js
 */
import assert from 'node:assert/strict';

import {
  initialState, legalMoves, isInCheck, isAttacked, gameStatus, pseudoMoves, idx, FILES, RANKS, RED, BLACK,
} from '../src/engine/rules.js';
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

const CH = {
  G: { type: 'general', side: RED }, g: { type: 'general', side: BLACK },
  A: { type: 'advisor', side: RED }, a: { type: 'advisor', side: BLACK },
  E: { type: 'elephant', side: RED }, e: { type: 'elephant', side: BLACK },
  H: { type: 'horse', side: RED }, h: { type: 'horse', side: BLACK },
  R: { type: 'chariot', side: RED }, r: { type: 'chariot', side: BLACK },
  C: { type: 'cannon', side: RED }, c: { type: 'cannon', side: BLACK },
  P: { type: 'pawn', side: RED }, p: { type: 'pawn', side: BLACK },
};

function build(rows, turn) {
  const board = new Array(90).fill(null);
  rows.forEach((row, r) => [...row].forEach((ch, f) => {
    if (ch !== '.') board[idx(f, r)] = { ...CH[ch] };
  }));
  return { board, turn, history: [] };
}
const sq = (f, r) => idx(f, r);
const pairs = (ms) => ms.map((m) => `${m.from % FILES},${Math.floor(m.from / FILES)}->${m.to % FILES},${Math.floor(m.to / FILES)}`);

console.log('check（按改过的规则）');

/* ---------- 1. 送将不再被过滤 ---------- */
check('被将军时也能走"仍被将"的着法（不过滤）', () => {
  // 黑车 (4,8) 贴脸将军红帅 (4,9)
  const s = build([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....r....',
    '....G....',
  ], RED);
  assert.equal(isAttacked(s.board, RED), true, '应被攻击');
  const legal = legalMoves(s, RED);
  assert.ok(legal.length > 0, '应当有着法');
  // 帅往左右躲，仍然会被车横向追击？车在 (4,8)，帅到 (3,9) 后就脱离攻击了。
  // 这里只断言"引擎不再因为送将而把着法整批滤掉"。
  const pseudo = pseudoMoves(s, RED);
  assert.equal(legal.length, pseudo.length, '新规则下合法着法应等于候选着法（不做送将过滤）');
});

/* ---------- 2. 帅能吃掉贴脸的攻击子 ---------- */
check('帅能直接吃掉贴脸的车', () => {
  const s = build([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....r....',
    '....G....',
  ], RED);
  assert.ok(
    legalMoves(s, RED).some((m) => m.from === sq(4, 9) && m.to === sq(4, 8)),
    `帅应当能吃掉 (4,8) 的车，实际: ${pairs(legalMoves(s, RED))}`,
  );
});

/* ---------- 3. 吃掉将/帅即胜 ---------- */
check('红帅被吃掉 → 黑方获胜，reason = general-captured', () => {
  const s = build([
    '....g....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....r....',
    '.........',
  ], BLACK);
  const st = gameStatus(s);
  assert.equal(st.over, true, '应判结束');
  assert.equal(st.winner, BLACK, `应黑方胜，实际 ${st.winner}/${st.reason}`);
  assert.equal(st.reason, 'general-captured');
});

check('黑将被吃掉 → 红方获胜', () => {
  const s = build([
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....R....',
    '....G....',
  ], RED);
  const st = gameStatus(s);
  assert.equal(st.over, true);
  assert.equal(st.winner, RED);
  assert.equal(st.reason, 'general-captured');
});

/* ---------- 4. 没有将死 / 困毙 ---------- */
check('没有"将死"：帅还在就继续下', () => {
  // 旧测试里的将死局面：红车封住黑将两翼 + 贴身将军
  const s = build([
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
  assert.equal(isAttacked(s.board, BLACK), true, '黑将确实被攻击');
  assert.ok(legalMoves(s, BLACK).length > 0, '新规则下不可能是零着法');
  const st = gameStatus(s);
  assert.equal(st.over, false, `不该判结束，实际 ${st.reason}`);
  assert.equal(st.reason, 'check');
});

check('没有"困毙判负"：无子可走也不结束', () => {
  const s = build([
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
  assert.ok(legalMoves(s, BLACK).length > 0, '新规则下黑将总能乱走');
  assert.equal(gameStatus(s).over, false);
});

/* ---------- 5. 走法几何仍然正确（与胜负规则无关） ---------- */
check('走法几何没被改坏：开局 44 步、四只象各 2 步', () => {
  const st = initialState();
  assert.equal(legalMoves(st, RED).length, 44, '开局红方应为 44 步');
  let elephants = 0;
  for (let i = 0; i < 90; i++) {
    const p = st.board[i];
    if (!p || p.type !== 'elephant') continue;
    elephants++;
    assert.equal(legalMoves(st, p.side).filter((m) => m.from === i).length, 2);
  }
  assert.equal(elephants, 4);
});

check('将帅照面仍被识别为"被攻击"（用于提示，不再禁止走子）', () => {
  const s = build([
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
  ], RED);
  assert.equal(isInCheck(s.board, RED), true, '照面仍算被将军（提示用）');
  // 但依然可以随便走
  assert.ok(legalMoves(s, RED).length > 0);
});

/* ---------- 6. AI 在新规则下仍能正常出招 ---------- */
check('AI 能一步吃掉对方的帅（四档都会）', () => {
  const s = build([
    '....g....',
    '.........',
    '.........',
    '.........',
    '....r....',
    '.........',
    '.........',
    '.........',
    '.........',
    '....G....',
  ], BLACK);
  for (const lv of [1, 2, 3, 4]) {
    const mv = chooseMove(s, lv);
    assert.ok(mv, `档位 ${lv} 返回 null`);
    assert.equal(mv.to, sq(4, 9), `档位 ${lv} 应吃掉红帅，实际 ${pairs([mv])}`);
  }
});

check('随机对局：在改动过的规则下不崩、且总能走完', () => {
  let seed = 20261006;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const st = initialState();
  const game = { state: st, moves: [], captured: [], lastMove: null };
  let plies = 0;
  let ended = null;
  for (let i = 0; i < 800; i++) {
    const moves = legalMoves(st, st.turn);
    if (!moves.length) { ended = 'no-moves'; break; }
    const mv = moves[Math.floor(rnd() * moves.length)];
    const r = applyMove(game, mv);
    if (!r.ok) { ended = `apply-failed:${r.reason}`; break; }
    plies++;
    const done = gameStatus(st);
    if (done.over) { ended = done.reason; break; }
  }
  console.log(`      （走了 ${plies} 步，结束原因: ${ended ?? '未结束'}）`);
  assert.ok(plies > 20, `只走了 ${plies} 步就停了：${ended}`);
  assert.ok(
    ended === null || ended === 'general-captured' || ended === 'no-moves',
    `结束原因异常: ${ended}`,
  );
});

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
