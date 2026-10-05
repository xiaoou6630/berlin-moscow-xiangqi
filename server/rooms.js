/**
 * 局域网房间：房主(红) vs 客机(黑)。
 *
 * 服务端做权威校验（用同一份引擎规则判合法着法），
 * 免得两边各自算导致局面不一致。
 */
import { BLACK, RED, gameStatus, initialState, legalMoves } from '../src/engine/rules.js';

const nextId = (() => {
  let n = 0;
  return () => String(++n).padStart(3, '0');
})();

export class Room {
  constructor() {
    this.id = nextId();
    /** 'waiting' | 'playing' | 'over' */
    this.phase = 'waiting';
    this.state = initialState();
    this.players = { red: null, black: null };
    this.level = 2;
    this.moves = [];
    /** 建房时间：自动匹配只挑最近建的房，避免连进早就没人管的空房 */
    this.createdAt = Date.now();
  }

  get full() {
    return Boolean(this.players.red && this.players.black);
  }

  get empty() {
    return !this.players.red && !this.players.black;
  }

  /** 分配一个颜色座位 */
  seat(conn) {
    const side = !this.players.red ? RED : !this.players.black ? BLACK : null;
    if (!side) return null;
    this.players[side] = conn;
    conn.meta.room = this;
    conn.meta.side = side;
    return side;
  }

  leave(conn) {
    for (const side of [RED, BLACK]) {
      if (this.players[side] === conn) this.players[side] = null;
    }
    if (!this.players.red && !this.players.black) this.phase = 'waiting';
    else if (this.phase === 'playing') this.phase = 'waiting';
  }

  broadcast(payload) {
    for (const side of [RED, BLACK]) this.players[side]?.send(JSON.stringify(payload));
  }

  /**
   * 开局（房主点"开始"）。
   * @param {number} level
   * @param {boolean} force 重赛时才允许在对局中重置
   */
  start(level, force = false) {
    // 对局进行中不允许被房主一键清零重开（否则对手的棋盘会凭空重置）
    if (this.phase === 'playing' && !force) return { ok: false, error: 'already-playing' };
    this.level = level ?? this.level;
    this.state = initialState();
    this.moves = [];
    this.phase = 'playing';
    this.broadcast({ t: 'start', level: this.level });
    this.sync();
    return { ok: true };
  }

  /** 把当前局面发给双方 */
  sync() {
    const st = gameStatus(this.state);
    this.broadcast({
      t: 'state',
      turn: this.state.turn,
      last: this.moves[this.moves.length - 1] ?? null,
      moves: this.moves.length,
      over: st.over,
      winner: st.winner ?? null,
      reason: st.reason,
    });
  }

  /**
   * 处理一步棋。
   * @returns {{ok:boolean, error?:string}}
   */
  move(conn, from, to) {
    const side = conn.meta.side;
    if (!side || this.phase !== 'playing') return { ok: false, error: 'not-playing' };
    if (this.state.turn !== side) return { ok: false, error: 'not-your-turn' };

    const legal = legalMoves(this.state, side).some((m) => m.from === from && m.to === to);
    if (!legal) return { ok: false, error: 'illegal' };

    const captured = this.state.board[to];
    const piece = this.state.board[from];
    this.state.board[to] = piece;
    this.state.board[from] = null;
    this.state.turn = side === RED ? BLACK : RED;

    const record = { from, to, side, type: piece.type, captured: captured ? { ...captured } : null };
    this.moves.push(record);
    this.broadcast({ t: 'move', ...record });
    this.sync();

    const st = gameStatus(this.state);
    if (st.over) {
      this.phase = 'over';
      this.broadcast({ t: 'over', winner: st.winner, reason: st.reason });
    }
    return { ok: true };
  }
}

export class RoomStore {
  constructor() {
    this.rooms = new Map();
  }

  create() {
    const room = new Room();
    this.rooms.set(room.id, room);
    return room;
  }

  /**
   * 客机加入。
   * - 带房间号：**必须**是已存在的房间。以前"房间不存在就现建一个"，
   *   结果房主号打错时客机会静默连进一间幽灵房（显示"已连接"却永远等不到人）。
   * - 不带房间号：自动找一间正在等人、且最近建的房。
   * @returns {Room|null} null 表示房间不存在
   */
  join(id) {
    if (id) return this.rooms.get(id) ?? null;
    // 只看等待中的房（不是 playing/over），按建房时间倒序取最新的一间
    const waiting = [...this.rooms.values()]
      .filter((r) => r.phase === 'waiting' && !r.full)
      .sort((a, b) => b.createdAt - a.createdAt);
    return waiting[0] ?? null;
  }

  reap() {
    for (const [id, room] of this.rooms) {
      if (room.empty) this.rooms.delete(id);
    }
  }
}
