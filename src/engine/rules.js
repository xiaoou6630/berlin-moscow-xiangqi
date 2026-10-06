/**
 * 中国象棋核心规则（棋盘表示、走子合法性、将死/困毙判定）
 *
 * 规则依据《中国象棋竞赛规则》：
 *   - 棋盘 9 路 × 10 线，共 90 个交叉点，棋子落在交叉点上
 *   - 河界把棋盘分成两半；九宫为上下各 3×3
 *   - 帅/将、士/仕 不能出九宫；象/相 不能过河；兵/卒 过河后可横走
 *   - 炮 不吃子时走法同车；吃子必须隔且仅隔一个棋子（炮打隔子）
 *   - 马 走"日"，有蹩马腿；象/相 走"田"，有塞象眼
 *   - 将帅不能在同一直线上直接对面（飞将）
 *   - 被将死或无子可走（困毙）均判负
 *
 * 棋盘用 90 长度的数组表示，索引 = rank * 9 + file。
 * rank 0 = 顶部（德军/黑方底线），rank 9 = 底部（苏军/红方底线）。
 */

export const FILES = 9;
export const RANKS = 10;

/** id = file + rank * 9 */
export const idx = (file, rank) => rank * FILES + file;
export const fileOf = (id) => id % FILES;
export const rankOf = (id) => Math.floor(id / FILES);
export const onBoard = (file, rank) => file >= 0 && file < FILES && rank >= 0 && rank < RANKS;

export const RED = 'red'; // 苏军（下方）
export const BLACK = 'black'; // 德军（上方）

export const PIECE_TYPES = {
  general: '帅/将',
  advisor: '士/仕',
  elephant: '象/相',
  horse: '马',
  chariot: '车',
  cannon: '炮',
  pawn: '兵/卒',
};

/** 眼（用于渲染：走法文字标签） */
export const ROLE_LABEL = {
  red: { general: '帅', advisor: '仕', elephant: '相', horse: '马', chariot: '车', cannon: '炮', pawn: '兵' },
  black: { general: '将', advisor: '士', elephant: '象', horse: '馬', chariot: '車', cannon: '砲', pawn: '卒' },
};

/* ------------------------------------------------------------------ *
 * 初始局面
 * ------------------------------------------------------------------ */

/** 底线自左向右的排列（对称） */
const BACK_RANK = ['chariot', 'horse', 'elephant', 'advisor', 'general', 'advisor', 'elephant', 'horse', 'chariot'];

/**
 * 返回初始局面。
 * 红方（苏军）在下，黑方（德军）在上。
 * @returns {{board: Array, turn: string, history: Array}}
 */
export function initialState() {
  const board = new Array(FILES * RANKS).fill(null);

  for (let f = 0; f < FILES; f++) {
    board[idx(f, 0)] = { type: BACK_RANK[f], side: BLACK };
    board[idx(f, 9)] = { type: BACK_RANK[f], side: RED };
  }
  // 炮位：第 2、8 路
  for (const f of [1, 7]) {
    board[idx(f, 2)] = { type: 'cannon', side: BLACK };
    board[idx(f, 7)] = { type: 'cannon', side: RED };
  }
  // 兵位：第 1、3、5、7、9 路
  for (const f of [0, 2, 4, 6, 8]) {
    board[idx(f, 3)] = { type: 'pawn', side: BLACK };
    board[idx(f, 6)] = { type: 'pawn', side: RED };
  }

  return { board, turn: RED, history: [] };
}

export function cloneState(state) {
  return {
    board: state.board.slice(),
    turn: state.turn,
    history: state.history.slice(),
  };
}

/** 深拷贝单个棋子（棋子是纯数据对象） */
const cp = (p) => (p ? { type: p.type, side: p.side } : null);

/* ------------------------------------------------------------------ *
 * 走子规则
 * ------------------------------------------------------------------ */

const inPalace = (file, rank, side) =>
  file >= 3 && file <= 5 && (side === RED ? rank >= 7 && rank <= 9 : rank >= 0 && rank <= 2);

/** 是否已过河 */
const crossedRiver = (rank, side) => (side === RED ? rank <= 4 : rank >= 5);

/**
 * 伪合法走法（不检查走后是否自将）。返回 [{ from, to }]
 */
export function pseudoMoves(state, side = state.turn) {
  const moves = [];
  const { board } = state;

  const push = (from, file, rank) => {
    if (!onBoard(file, rank)) return;
    const target = board[idx(file, rank)];
    if (target && target.side === side) return;
    moves.push({ from, to: idx(file, rank) });
  };

  for (let from = 0; from < board.length; from++) {
    const piece = board[from];
    if (!piece || piece.side !== side) continue;
    const f = fileOf(from);
    const r = rankOf(from);

    switch (piece.type) {
      case 'general': {
        for (const [df, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const nf = f + df;
          const nr = r + dr;
          if (inPalace(nf, nr, side)) push(from, nf, nr);
        }
        break;
      }

      case 'advisor': {
        for (const [df, dr] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nf = f + df;
          const nr = r + dr;
          if (inPalace(nf, nr, side)) push(from, nf, nr);
        }
        break;
      }

      case 'elephant': {
        for (const [df, dr] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
          const nf = f + df;
          const nr = r + dr;
          if (!onBoard(nf, nr)) continue;
          if (crossedRiver(nr, side)) continue; // 象不过河
          const eye = idx(f + df / 2, r + dr / 2);
          if (board[eye]) continue; // 塞象眼
          push(from, nf, nr);
        }
        break;
      }

      case 'horse': {
        // 马腿 = 沿"较大位移的那条轴"走一格的那格。
        // 位移 (±2,±1) → 马腿在 (f±1, r)；位移 (±1,±2) → 马腿在 (f, r±1)
        for (const [df, dr] of [
          [1, 2], [-1, 2], [1, -2], [-1, -2],
          [2, 1], [2, -1], [-2, 1], [-2, -1],
        ]) {
          const nf = f + df;
          const nr = r + dr;
          if (!onBoard(nf, nr)) continue;
          const legFile = Math.abs(df) === 2 ? f + df / 2 : f;
          const legRank = Math.abs(df) === 2 ? r : r + dr / 2;
          if (board[idx(legFile, legRank)]) continue; // 蹩马腿
          push(from, nf, nr);
        }
        break;
      }

      case 'chariot': {
        for (const [df, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          let nf = f + df;
          let nr = r + dr;
          while (onBoard(nf, nr)) {
            const t = board[idx(nf, nr)];
            if (!t) {
              moves.push({ from, to: idx(nf, nr) });
            } else {
              if (t.side !== side) moves.push({ from, to: idx(nf, nr) });
              break;
            }
            nf += df;
            nr += dr;
          }
        }
        break;
      }

      case 'cannon': {
        for (const [df, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          let nf = f + df;
          let nr = r + dr;
          let screen = false;
          while (onBoard(nf, nr)) {
            const t = board[idx(nf, nr)];
            if (!screen) {
              if (!t) {
                moves.push({ from, to: idx(nf, nr) }); // 炮不吃子时同车
              } else {
                screen = true; // 遇到第一个子，作为炮架
              }
            } else if (t) {
              if (t.side !== side) moves.push({ from, to: idx(nf, nr) }); // 炮打隔子
              break;
            }
            nf += df;
            nr += dr;
          }
        }
        break;
      }

      case 'pawn': {
        const forward = side === RED ? -1 : 1;
        push(from, f, r + forward); // 向前一步
        if (crossedRiver(r, side)) {
          push(from, f - 1, r); // 过河后可横走
          push(from, f + 1, r);
        }
        break;
      }

      default:
        break;
    }
  }

  return moves;
}

/** 两个将帅是否在同一直线上直接对面（中间无子） */
export function generalsFace(board) {
  let red = -1;
  let black = -1;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p && p.type === 'general') {
      if (p.side === RED) red = i;
      else black = i;
    }
  }
  if (red < 0 || black < 0) return false;
  if (fileOf(red) !== fileOf(black)) return false;
  const f = fileOf(red);
  const lo = Math.min(rankOf(red), rankOf(black));
  const hi = Math.max(rankOf(red), rankOf(black));
  for (let r = lo + 1; r < hi; r++) {
    if (board[idx(f, r)]) return false;
  }
  return true;
}

/** 查找某方的将/帅位置，找不到返回 -1 */
export function findGeneral(board, side) {
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p && p.type === 'general' && p.side === side) return i;
  }
  return -1;
}

/** 在给定棋盘上，side 方是否正被将军 */
export function isInCheck(board, side) {
  if (isAttacked(board, side)) return true;
  // 将帅照面：正规规则里等同于被将军（所以这里也算进去）
  return generalsFace(board);
}

/**
 * side 方的将/帅是否正被**某个子攻击**（不含"将帅照面"）。
 *
 * 吃帅模式要用这个而不是 isInCheck：那种玩法下"照面"本身不构成将军，
 * 否则 UI 会画一个红圈说"你被将了"，但其实没人能吃你的帅。
 */
export function isAttacked(board, side) {
  const g = findGeneral(board, side);
  if (g < 0) return false; // 已经被吃掉，不叫"被将"
  const gf = fileOf(g);
  const gr = rankOf(g);
  const foe = side === RED ? BLACK : RED;

  // 车 / 炮 / 兵 / 将 沿直线
  const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  for (const [df, dr] of dirs) {
    let nf = gf + df;
    let nr = gr + dr;
    let blockers = 0;
    while (onBoard(nf, nr)) {
      const p = board[idx(nf, nr)];
      if (p) {
        if (blockers === 0) {
          // 第一个子：车、将（贴脸）、兵
          if (p.side === foe) {
            if (p.type === 'chariot') return true;
            if (p.type === 'general' && Math.abs(nf - gf) + Math.abs(nr - gr) === 1) return true;
            if (p.type === 'pawn') {
              const step = p.side === RED ? -1 : 1; // 该兵的前进方向
              const dr2 = nr - gr;
              const df2 = nf - gf;
              if (df2 === 0 && dr2 === -step) return true; // 正前方一步被兵吃
              // 过河兵横吃：**必须相邻一路**。这里曾经漏了距离判断，
              // 导致同排任何距离的过河兵都被判成将军（假将死、吞掉合法着法）。
              if (Math.abs(df2) === 1 && dr2 === 0 && crossedRiver(nr, p.side)) return true;
            }
          }
          blockers = 1;
        } else {
          // 第二个子：炮
          if (p.side === foe && p.type === 'cannon') return true;
          break;
        }
      }
      nf += df;
      nr += dr;
    }
  }

  // 马：从将/帅的位置反推，马在哪个"日"角上，并检查对应的马腿
  for (const [df, dr] of [
    [1, 2], [-1, 2], [1, -2], [-1, -2],
    [2, 1], [2, -1], [-2, 1], [-2, -1],
  ]) {
    const hf = gf + df;
    const hr = gr + dr;
    if (!onBoard(hf, hr)) continue;
    const p = board[idx(hf, hr)];
    if (!p || p.side !== foe || p.type !== 'horse') continue;
    // 马腿 = 马沿较大位移轴走一格的那格
    const leg = Math.abs(df) === 2
      ? idx(hf + (gf - hf) / 2, hr)
      : idx(hf, hr + (gr - hr) / 2);
    if (!board[leg]) return true;
  }

  return false;
}

/** 走后己方是否被将军 */
function leavesKingExposed(state, move, side) {
  const board = state.board.slice();
  board[move.to] = cp(board[move.from]);
  board[move.from] = null;
  return isInCheck(board, side);
}

/**
 * 全部合法走法。
 *
 * ⚠️ 本项目**故意去掉了"不允许送将"这条规则**（用户要求：正常模式就能吃帅）。
 * 所以这里不过滤 leavesKingExposed：
 *   - 任何子都可以随便走，被将军时也不必应将
 *   - 将/帅可以被吃掉（被吃即输，见 gameStatus）
 *   - 因此不存在"某个子一步都动不了"的情况
 *
 * 代价（都是去规则的必然结果，不是 bug）：
 *   - 没有"将死"，胜负只由"帅被吃"决定
 *   - 没有"困毙判负"：无子可走只是没得走，不判负
 *   - 引擎仍会偏好吃掉对方的帅（评估函数里帅分值极高）
 */
export function legalMoves(state, side = state.turn) {
  return pseudoMoves(state, side);
}

/** 找某方的将/帅；返回 -1 表示已被吃掉 */
export function findGeneralIndex(board, side) {
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p && p.type === 'general' && p.side === side) return i;
  }
  return -1;
}

/**
 * 局面判定。
 *
 * ⚠️ 本项目的胜负规则（按用户要求改过）：
 *   - **唯一取胜方式：吃掉对方的将/帅**。被吃的一方立刻判负。
 *   - 没有"将死"，没有"困毙判负"。被将军也可以不管、可以随便走，
 *     只要你的帅没被吃掉，对局就继续。
 *   - 无子可走（走投无路）不判负，只是这一方没得走；
 *     如果轮到的一方彻底无子可走且双方都还在，按"无着可走"停止（winner 为空）。
 *
 * @returns {{over:boolean, winner:?string, reason:string, checked:boolean}}
 */
export function gameStatus(state) {
  const side = state.turn;

  // 1) 只看将/帅还在不在 —— 这是唯一的胜负依据
  const redAlive = findGeneralIndex(state.board, RED) >= 0;
  const blackAlive = findGeneralIndex(state.board, BLACK) >= 0;
  if (!redAlive || !blackAlive) {
    if (!redAlive && !blackAlive) {
      return { over: true, winner: null, reason: 'both-general-captured', checked: false };
    }
    return {
      over: true,
      winner: redAlive ? RED : BLACK,
      reason: 'general-captured',
      checked: false,
    };
  }

  // 2) 还在下：只是提示"你的将正被攻击"（可以让玩家选择不管）
  const checked = isAttacked(state.board, side);
  const moves = legalMoves(state, side);
  if (moves.length === 0) {
    // 无子可走：不判负（规则已去掉），也算不上终局，交给上层提示
    return { over: true, winner: null, reason: 'no-moves', checked };
  }
  return { over: false, winner: null, reason: checked ? 'check' : 'normal', checked };
}
