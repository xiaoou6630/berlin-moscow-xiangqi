/**
 * 对局状态封装：走子、悔棋、判定。
 */
import {
  BLACK,
  RED,
  cloneState,
  findGeneral,
  gameStatus,
  initialState as baseInitial,
  isInCheck,
  legalMoves,
  rankOf,
  fileOf,
  idx,
} from './rules.js';

export { RED, BLACK };

/** @typedef {{from:number,to:number}} Move */

export function createGame({ humanSide = RED } = {}) {
  const state = baseInitial();
  return {
    state,
    humanSide,
    /** 已走的着法，用于悔棋与展示 */
    moves: [],
    /** 被吃掉的棋子 { side, type } */
    captured: [],
    /** 最近一次走子（渲染动画用） */
    lastMove: null,
  };
}

/** 本地引擎自动走一步（用于对手或自动演示） */
export function applyEngineMove(game, move) {
  return applyMove(game, move);
}

/**
 * 走一步棋。
 * @returns {{ok:boolean, reason?:string, from?:number, to?:number, captured?:object}}
 */
export function applyMove(game, move) {
  const { state } = game;
  const piece = state.board[move.from];
  if (!piece || piece.side !== state.turn) return { ok: false, reason: 'not-your-piece' };

  const legal = legalMoves(state, state.turn).some((m) => m.from === move.from && m.to === move.to);
  if (!legal) return { ok: false, reason: 'illegal' };

  const target = state.board[move.to];
  state.board[move.to] = piece;
  state.board[move.from] = null;

  const record = { from: move.from, to: move.to, piece: { type: piece.type, side: piece.side }, captured: target ? { ...target } : null };
  game.moves.push(record);
  game.lastMove = record;
  if (target) game.captured.push({ ...target });

  state.turn = state.turn === RED ? BLACK : RED;
  return { ok: true, ...record };
}

/** 悔棋一步（回退到上一次己方该走之前） */
export function undo(game, steps = 1) {
  for (let i = 0; i < steps; i++) {
    const rec = game.moves.pop();
    if (!rec) return false;
    const { state } = game;
    state.board[rec.from] = rec.piece;
    state.board[rec.to] = rec.captured ?? null;
    if (rec.captured) game.captured.pop();
    state.turn = rec.piece.side;
    game.lastMove = game.moves[game.moves.length - 1] ?? null;
  }
  return true;
}

export function status(game) {
  return gameStatus(game.state);
}

export function movesFor(game, from) {
  return legalMoves(game.state, game.state.turn).filter((m) => m.from === from);
}

export function inCheck(game, side = game.state.turn) {
  return isInCheck(game.state.board, side);
}

/** 便捷：把局面转成可读文本（调试与测试用） */
export function boardToString(state) {
  const rows = [];
  for (let r = 0; r < 10; r++) {
    let line = '';
    for (let f = 0; f < 9; f++) {
      const p = state.board[idx(f, r)];
      if (!p) line += ' .';
      else {
        const ch = { general: 'G', advisor: 'A', elephant: 'E', horse: 'H', chariot: 'R', cannon: 'C', pawn: 'P' }[p.type];
        line += ' ' + (p.side === RED ? ch.toLowerCase() : ch);
      }
    }
    rows.push(line);
  }
  return rows.join('\n');
}

export { findGeneral, rankOf, fileOf, idx };
