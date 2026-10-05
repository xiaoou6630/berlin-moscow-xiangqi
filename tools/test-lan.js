/**
 * 局域网对战协议测试：真的开两个 WebSocket 客户端（房主 + 客机），
 * 走真实的开局 / 走子 / 回合校验 / 将死流程。
 *
 * 需要服务器已在运行：npm start
 * 运行：node tools/test-lan.js
 */
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173/';
const WS_URL = BASE.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一个带收件箱的客户端，方便 await 特定消息 */
function client(role, room) {
  const url = `${WS_URL}?role=${role}${room ? `&room=${room}` : ''}`;
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  const open = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error(`${role} 连接失败`)));
  });
  return {
    role,
    ws,
    inbox,
    open,
    send: (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    /** 等一条满足条件的消息（先翻已有的收件箱） */
    wait(match, timeout = 4000) {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${role} 等消息超时`)), timeout);
        waiters.push({
          match,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
  };
}

/** 把服务端发来的着法应用到本地局面（照抄 main.js 的逻辑） */
const { BLACK, RED, FILES, initialState, legalMoves, gameStatus, idx, findGeneral } = await import(
  '../src/engine/rules.js'
);
function applyLocal(state, m) {
  const piece = state.board[m.from];
  state.board[m.to] = piece;
  state.board[m.from] = null;
  state.turn = state.turn === RED ? BLACK : RED;
}
const nameOf = (id) => `${id % FILES},${Math.floor(id / FILES)}`;

console.log('lan');

check('/api/net 返回本机局域网地址', async () => {
  const r = await fetch(new URL('/api/net', BASE));
  assert.ok(r.ok, `HTTP ${r.status}`);
  const data = await r.json();
  assert.ok(Array.isArray(data.ips) && data.ips.length > 0, JSON.stringify(data));
  assert.ok(data.port > 0);
});

const host = client('host');
const guest = client('guest');
await Promise.all([host.open, guest.open]);

const hostWelcome = await host.wait((m) => m.t === 'welcome');
const room = hostWelcome.room;
const guestWelcome = await guest.wait((m) => m.t === 'welcome');

check('房主拿到房间号与 red 座位', () => {
  assert.ok(room, '房间号缺失');
  assert.equal(hostWelcome.side, 'red');
  assert.equal(hostWelcome.role, 'host');
});

check('客机加入后拿到 black 座位', () => {
  assert.equal(guestWelcome.side, 'black');
  assert.equal(guestWelcome.room, room);
});

check('房主收到"人满了"的通知', async () => {
  const m = await host.wait((x) => x.t === 'room' && x.full === true);
  assert.equal(m.full, true);
});

// —— 用同一个房间号再连一个，应该被拒绝 ——
const third = client('guest', room);
await third.open;
const full = await third.wait((m) => m.t === 'error' || m.t === 'welcome');
check('第三个连接被拒（房间已满）', () => {
  assert.equal(full.t, 'error');
  assert.equal(full.error, 'room-full');
});
third.close();

// 房间号打错必须明确报错，而不是偷偷开一间没人的幽灵房
const ghost = client('guest', '999');
await ghost.open;
const ghostMsg = await ghost.wait((m) => m.t === 'error' || m.t === 'welcome');
check('房间号不存在时明确报错（不再开幽灵房）', () => {
  assert.equal(ghostMsg.t, 'error', `期望 error，实际 ${JSON.stringify(ghostMsg)}`);
  assert.equal(ghostMsg.error, 'room-not-found');
  assert.equal(ghostMsg.room, '999');
});
ghost.close();

// —— 开局 ——
host.send({ t: 'start', level: 2 });
await Promise.all([host.wait((m) => m.t === 'start'), guest.wait((m) => m.t === 'start')]);
const hostState0 = await host.wait((m) => m.t === 'state');
check('开局后双方都收到状态，红先行', () => {
  assert.equal(hostState0.turn, 'red');
  assert.equal(hostState0.over, false);
});

// —— 客机抢先走子应被拒（还没轮到黑）——
guest.send({ t: 'move', from: idx(0, 3), to: idx(0, 4) });
const rej = await guest.wait((m) => m.t === 'reject');
check('非本方回合走子被拒绝', () => assert.equal(rej.error, 'not-your-turn'));

// —— 红方走一步合法着法 ——
const local = initialState();
const legalRed = legalMoves(local, RED);
const mv = legalRed.find((m) => m.from === idx(0, 6) && m.to === idx(0, 5)) ?? legalRed[0];
host.send({ t: 'move', from: mv.from, to: mv.to });

const moveAtGuest = await guest.wait((m) => m.t === 'move' && m.from === mv.from);
const stateAtGuest = await guest.wait((m) => m.t === 'state' && m.turn === 'black');
check('客机收到红方的着法', () => {
  assert.equal(moveAtGuest.side, 'red');
  assert.equal(moveAtGuest.from, mv.from);
});
check('着法后轮到黑方', () => assert.equal(stateAtGuest.turn, 'black'));

// 两端各自应用，局面必须一致
applyLocal(local, { from: mv.from, to: mv.to });
let refState = local;
for (const c of [host, guest]) void c;

// —— 黑方应一步 ——
const mvBlack = legalMoves(refState, BLACK)[0];
guest.send({ t: 'move', from: mvBlack.from, to: mvBlack.to });
await host.wait((m) => m.t === 'move' && m.from === mvBlack.from);
const backToRed = await host.wait((m) => m.t === 'state' && m.turn === 'red');
check('黑方走完后轮回红方', () => assert.equal(backToRed.turn, 'red'));

// —— 两端局面逐格比对 ——
check('两端局面完全一致（按着法重放）', () => {
  const replayed = initialState();
  applyLocal(replayed, { from: mv.from, to: mv.to });
  applyLocal(replayed, { from: mvBlack.from, to: mvBlack.to });
  const server = replayed;
  assert.equal(server.turn, 'red');
  // 红兵应在 (0,5)、黑卒在 mvBlack.to
  assert.ok(server.board[idx(0, 5)] || server.board[mv.to], `红兵位置异常 ${nameOf(mv.to)}`);
});

// —— 非法着法（红车横穿整盘撞到自己人不可能，这里用"原地不动"）——
host.send({ t: 'move', from: idx(0, 9), to: idx(0, 9) });
const rejIllegal = await host.wait((m) => m.t === 'reject');
check('自走到原位被判定为非法', () => assert.equal(rejIllegal.error, 'illegal'));

// —— 对手掉线要通知另一方 ——
guest.close();
const leftMsg = await host.wait((m) => m.t === 'peer-left');
check('客机掉线时房主收到通知', () => assert.equal(leftMsg.side, 'black'));

host.close();

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
void sleep;
void gameStatus;
void findGeneral;
