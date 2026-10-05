/**
 * 极小象棋引擎：Alpha-Beta 搜索 + 子力/位置评估。
 * 目标：零依赖、体积小、搜索够快（默认时间上限 600ms）。
 */
import {
  BLACK,
  FILES,
  RED,
  RANKS,
  fileOf,
  idx,
  legalMoves,
  rankOf,
} from './rules.js';

/** 子力价值 */
const VALUE = {
  general: 6000,
  chariot: 900,
  cannon: 450,
  horse: 420,
  advisor: 200,
  elephant: 200,
  pawn: 100,
};

/** 位置加成：过河兵、控制中路等 */
function positional(piece, file, rank) {
  const f = file;
  const r = rank;
  let bonus = 0;
  const centerBonus = 4 - Math.abs(4 - f); // 中路更高

  switch (piece.type) {
    case 'pawn': {
      const advanced = piece.side === RED ? 6 - r : r - 3; // 越大越靠近对方
      bonus += Math.max(0, advanced) * 12 + centerBonus * 2;
      if (piece.side === RED ? r <= 4 : r >= 5) bonus += 20; // 过河
      break;
    }
    case 'horse':
    case 'cannon':
      bonus += centerBonus * 3;
      break;
    case 'chariot':
      bonus += centerBonus * 2;
      break;
    default:
      break;
  }
  return bonus;
}

/** 从走子方视角评估局面（正数 = 走子方占优） */
export function evaluate(state, side) {
  let score = 0;
  const board = state.board;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p) continue;
    const v = VALUE[p.type] + positional(p, fileOf(i), rankOf(i));
    score += p.side === side ? v : -v;
  }
  return score;
}

/** 走法排序：吃子优先，按被吃子价值降序 */
function scoreMove(state, move) {
  const target = state.board[move.to];
  if (!target) return 0;
  return VALUE[target.type];
}

function ordered(state, moves) {
  return moves
    .map((m) => ({ m, s: scoreMove(state, m) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
}

/** 把走法应用到一个棋盘的副本上 */
function makeMove(state, move) {
  const board = state.board.slice();
  board[move.to] = board[move.from];
  board[move.from] = null;
  return { board, turn: state.turn === RED ? BLACK : RED, history: [] };
}

/**
 * Alpha-Beta 搜索。
 * @returns {number} 从 side 视角的分数
 */
function search(state, side, depth, alpha, beta, deadline) {
  if (Date.now() > deadline) return evaluate(state, side);

  const moves = legalMoves(state, state.turn);
  if (moves.length === 0) {
    // 无子可走：被将死或困毙，均判负
    return state.turn === side ? -100000 - depth : 100000 + depth;
  }
  if (depth <= 0) {
    return evaluate(state, side);
  }

  const maximizing = state.turn === side;
  let best = maximizing ? -Infinity : Infinity;

  for (const move of ordered(state, moves)) {
    const child = makeMove(state, move);
    const value = search(child, side, depth - 1, alpha, beta, deadline);
    if (maximizing) {
      if (value > best) best = value;
      if (best > alpha) alpha = best;
    } else {
      if (value < best) best = value;
      if (best < beta) beta = best;
    }
    if (beta <= alpha) break; // 剪枝
  }
  return best;
}

/** 可调档位 */
export const LEVELS = [
  { id: 1, name: '新兵', depth: 2, timeMs: 250, random: 0.35 },
  { id: 2, name: '老兵', depth: 3, timeMs: 400, random: 0.15 },
  { id: 3, name: '军官', depth: 4, timeMs: 700, random: 0.05 },
  { id: 4, name: '元帅', depth: 5, timeMs: 1200, random: 0 },
];

/**
 * 选一步棋。
 * @param {object} state 当前局面
 * @param {number|object} level 档位 id 或档位对象
 * @returns {?{from:number,to:number}}
 */
export function chooseMove(state, level = 2) {
  const cfg = typeof level === 'object' ? level : LEVELS.find((l) => l.id === level) ?? LEVELS[1];
  const moves = legalMoves(state, state.turn);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  const side = state.turn;

  // 低档位随机放水
  if (cfg.random > 0 && Math.random() < cfg.random) {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  const deadline = Date.now() + (cfg.timeMs ?? 500);
  let best = moves[0];
  let bestScore = -Infinity;

  // 逐层加深，超时就用上一层的结果
  for (let depth = 1; depth <= cfg.depth; depth++) {
    let localBest = null;
    let localScore = -Infinity;
    let aborted = false;

    for (const move of ordered(state, moves)) {
      if (Date.now() > deadline) {
        aborted = true;
        break;
      }
      const child = makeMove(state, move);
      const value = search(child, side, depth - 1, -Infinity, Infinity, deadline);
      if (value > localScore) {
        localScore = value;
        localBest = move;
      }
    }

    if (localBest && !aborted) {
      best = localBest;
      bestScore = localScore;
      if (bestScore > 90000) break; // 已经找到杀棋
    } else if (localBest && aborted && depth === 1) {
      best = localBest;
    }
    if (aborted) break;
  }

  void FILES;
  void RANKS;
  void idx;
  return best;
}
