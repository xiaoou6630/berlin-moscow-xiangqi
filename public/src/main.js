/**
 * 主控制器：选边 → 对局 → 判定胜负。
 *
 * 引擎直接引用 src/engine/（Node 测试与浏览器共用同一份代码）。
 */
import {
  BLACK,
  RED,
  FILES,
  RANKS,
  findGeneral,
  gameStatus,
  isInCheck,
  legalMoves,
  initialState,
  idx,
} from '#shared/engine/rules.js';
import { chooseMove, LEVELS } from '#shared/engine/ai.js';
import { CARD_RATIO, CARD_WIDTH_UNITS, DIFFICULTY_UI, FACTIONS, GERMANY, SOVIET, sideOfFaction } from './theme.js';
import { connectAsGuest, connectAsHost, lanInfo } from './lan.js';
// ⚠️ 这两个必须是**静态** import：页面用了 <base href="./public/">，
//    而 <base> 不影响 ES module 的相对解析（只影响 HTML 里的 URL）。
//    写成 import() 的话在 GitHub Pages 子路径下会解析错。
import { BoardView } from './ui/board-view.js';
import { preload, urlsForFactions } from './assets.js';

const canvas = document.getElementById('board');

/* ---------------- DOM ---------------- */
const menuEl = document.getElementById('menu');
const factionsEl = document.getElementById('factions');
const levelRowEl = document.getElementById('levelRow');
const modeRowEl = document.getElementById('modeRow');
const hostPanel = document.getElementById('hostPanel');
const guestPanel = document.getElementById('guestPanel');
const lanUrlEl = document.getElementById('lanUrl');
const roomCodeEl = document.getElementById('roomCode');
const hostStatusEl = document.getElementById('hostStatus');
const hostHintEl = document.getElementById('hostHint');
const guestStatusEl = document.getElementById('guestStatus');
const hostAddrEl = document.getElementById('hostAddr');
const joinRoomEl = document.getElementById('joinRoom');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const hotseatChk = document.getElementById('hotseatChk');
const hotseatWrap = document.getElementById('hotseatWrap');
const levelsLabel = document.getElementById('levelsLabel');
const startBtn = document.getElementById('startBtn');
const menuHint = document.getElementById('menuHint');
const resultEl = document.getElementById('result');
const resultBadge = document.getElementById('resultBadge');
const resultTitle = document.getElementById('resultTitle');
const resultReason = document.getElementById('resultReason');
const bannerEl = document.getElementById('banner');
const againBtn = document.getElementById('againBtn');
const backBtn = document.getElementById('backBtn');
const hud = document.getElementById('hud');
const hudBottom = document.getElementById('hudBottom');
const hudTopEl = document.getElementById('hudTop');
const hudSelfEl = document.getElementById('hudSelf');
const hudTopAvatar = document.getElementById('hudTopAvatar');
const hudTopName = document.getElementById('hudTopName');
const hudTopSub = document.getElementById('hudTopSub');
const hudSelfAvatar = document.getElementById('hudSelfAvatar');
const hudSelfName = document.getElementById('hudSelfName');
const hudSelfSub = document.getElementById('hudSelfSub');
const turnDot = document.getElementById('turnDot');
const turnText = document.getElementById('turnText');
const undoBtn = document.getElementById('undoBtn');
const menuBtn = document.getElementById('menuBtn');

/* ---------------- 状态 ---------------- */
const state = {
  factionId: null,
  levelId: 2,
  /** 'local' 同一台设备 | 'host' 我建房 | 'guest' 我加入 */
  mode: 'local',
  /** 联机链路 */
  link: null,
  linkSide: null,
  room: null,
  peerReady: false,
  games: 0,
  /** 对局运行态 */
  game: null,
  humanSide: RED,
  aiSide: BLACK,
  view: null,
  over: false,
  aiThinking: false,
};

/* ---------------- 选边界面 ---------------- */

function buildMenu() {
  factionsEl.innerHTML = '';
  for (const f of [SOVIET, GERMANY]) {
    const cfg = FACTIONS[f];
    const btn = document.createElement('button');
    btn.className = 'faction';
    btn.type = 'button';
    btn.dataset.id = f;
    btn.innerHTML = `
      <img src="./assets/${cfg.portrait}" alt="${cfg.name}" />
      <div class="fname">${cfg.name}</div>
      <div class="fsub">${cfg.subtitle}</div>
      <div class="fsides">执 ${cfg.side === 'red' ? '红（先行）' : '黑（后行）'}</div>
    `;
    btn.addEventListener('click', () => selectFaction(f));
    factionsEl.appendChild(btn);
  }

  levelRowEl.innerHTML = '';
  for (const lv of DIFFICULTY_UI) {
    const btn = document.createElement('button');
    btn.className = 'level';
    btn.type = 'button';
    btn.dataset.id = String(lv.id);
    btn.innerHTML = `${lv.name}<small>${lv.desc}</small>`;
    btn.addEventListener('click', () => selectLevel(lv.id));
    levelRowEl.appendChild(btn);
  }

  for (const btn of modeRowEl.querySelectorAll('.level')) {
    btn.addEventListener('click', () => selectMode(btn.dataset.mode));
  }

  paintMenuSelection();
}

function selectFaction(id) {
  state.factionId = id;
  paintMenuSelection();
}

function selectLevel(id) {
  state.levelId = id;
  paintMenuSelection();
}

function selectMode(mode) {
  state.mode = mode;
  hostPanel.hidden = mode !== 'host';
  guestPanel.hidden = mode !== 'guest';
  // 换模式时把旧的连接断掉
  if (mode === 'local') closeLink();
  paintMenuSelection();
  // 切到"我建房"就直接把房间开好，不用再点一次按钮 ——
  // 否则面板上一直显示占位符 "—"，很容易被当成"局域网坏了"
  if (mode === 'host' && !state.link) void openHost();
}

function paintMenuSelection() {
  for (const el of factionsEl.children) el.classList.toggle('on', el.dataset.id === state.factionId);
  for (const el of levelRowEl.children) el.classList.toggle('on', Number(el.dataset.id) === state.levelId);
  for (const el of modeRowEl.children) el.classList.toggle('on', el.dataset.mode === state.mode);

  const lan = state.mode !== 'local';
  hostPanel.hidden = state.mode !== 'host';
  guestPanel.hidden = state.mode !== 'guest';
  // 联机时档位只对"建房方本机 AI"有意义，加入方不需要选
  document.getElementById('levels').style.display = state.mode === 'guest' ? 'none' : '';
  // 同机双人的开关只在单人模式下有意义
  hotseatWrap.hidden = lan;
  hotseatChk.disabled = lan;
  levelsLabel.textContent = hotseatChk.checked
    ? '两人同机：不需要引擎'
    : '引擎档位（单人时对手的强度）';
  for (const el of levelRowEl.children) el.style.opacity = hotseatChk.checked ? '0.4' : '';
  // 联机的颜色由连接时分配，不需要先选阵营
  factionsEl.style.display = lan ? 'none' : '';

  const ok = lan ? true : Boolean(state.factionId);
  startBtn.disabled = !ok;

  if (state.mode === 'guest') {
    startBtn.textContent = '连接并加入';
    menuHint.textContent = state.peerReady ? '已连上房主，等房主开始' : '填入房主地址与房间号';
  } else if (state.mode === 'host') {
    // 房间还没建的时候，面板上是占位符，这时绝不能说"房间已开好"，
    // 否则用户会去分享一个 "—"
    startBtn.textContent = state.peerReady ? '开始对局' : state.link ? '等待对手加入…' : '创建房间';
    menuHint.textContent = state.peerReady
      ? '对手已就位，可以开始'
      : state.link
        ? '房间已开好，把上面的地址和房间号发给朋友'
        : '点下面的按钮创建房间，然后把地址和房间号发给朋友';
  } else {
    startBtn.textContent = '开始对局';
    if (!state.factionId) {
      menuHint.textContent = '先选一方，再选档位';
    } else {
      const cfg = FACTIONS[state.factionId];
      const lv = DIFFICULTY_UI.find((l) => l.id === state.levelId);
      menuHint.textContent =
        `你将指挥 ${cfg.name}（${cfg.side === 'red' ? '红方 · 先行' : '黑方 · 后行'}），引擎档位：${lv.name}`;
    }
  }
}

/* ---------------- 局域网 ---------------- */

function closeLink() {
  state.link?.close();
  state.link = null;
  state.linkSide = null;
  state.room = null;
  state.peerReady = false;
}

function setStatus(el, text, tone = '') {
  el.textContent = text;
  el.style.color = tone === 'err' ? '#e0453a' : tone === 'ok' ? '#7fd18a' : '';
}

/** 局域网：当前主机名兜底（即使 /api/net 挂了也要能显示地址） */
function fallbackHost() {
  return location.hostname || '127.0.0.1';
}

function fallbackPort() {
  return Number(location.port) || 5173;
}

/** 顶部横幅提示（非法着法、被拒绝等），2 秒后自动消失 */
let bannerTimer = 0;
function flashBanner(text) {
  if (!text) return;
  bannerEl.textContent = text;
  bannerEl.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    bannerEl.hidden = true;
  }, 2200);
}

/** 对局中对手掉线：给一个看得见的结果面板 */
function showPeerLeft() {
  clearResultTimer();
  resultBadge.textContent = '断';
  resultBadge.classList.add('lose');
  resultTitle.textContent = '对手已离开';
  resultReason.textContent = '连接已断开，本局到此为止';
  resultEl.hidden = false;
}

/** 结算面板的定时器要能取消，否则离开对局后它会突然盖到菜单上 */
let resultTimer = 0;
function clearResultTimer() {
  if (resultTimer) {
    clearTimeout(resultTimer);
    resultTimer = 0;
  }
}

/** 下一帧重算尺寸（用于"浮层显隐刚刚变化"这种时机） */
let remeasurePending = false;
function scheduleRemeasure() {
  if (remeasurePending) return;
  remeasurePending = true;
  requestAnimationFrame(() => {
    remeasurePending = false;
    measureAndResize();
  });
}

async function openHost() {
  closeLink();
  const port0 = fallbackPort();
  // 先把地址亮出来（用当前地址兜底），别让面板空着
  lanUrlEl.textContent = `${location.origin || `http://${fallbackHost()}:${port0}`}/`;
  roomCodeEl.textContent = '···';
  setStatus(hostStatusEl, '正在建房…');

  let url = lanUrlEl.textContent;
  let localPage = true;
  try {
    const info = await lanInfo();
    // lanInfo 已经判断过"页面是不是由本机服务器提供"：
    // 是就给出真实局域网 IP，不是（GitHub Pages / 域名托管）就给出页面自己的地址，
    // 绝不会再编一个 `xxx.github.io:5173` 这种根本不存在的地址。
    if (info.url) url = info.url;
    localPage = info.localPage !== false;
  } catch (err) {
    console.warn('取地址失败，用当前地址兜底', err);
  }
  lanUrlEl.textContent = url;

  // 静态托管上页面不是本机提供的，托管商一般也不会转发 /ws：
  // 先把话说清楚，别让人对着一个连不上的地址干等
  if (!localPage) {
    setStatus(
      hostStatusEl,
      '当前地址不是本机服务器，联机可能连不上',
      'err',
    );
    hostHintEl.textContent =
      '这台电脑要先跑 npm start，然后两台设备都打开它打印的局域网地址（例如 http://192.168.1.5:5173/）。'
      + '静态托管（GitHub Pages / 域名托管）上没有 Node 服务器，联机用不了。';
  }

  try {
    state.link = connectAsHost(null, {
      onOpen: () => setStatus(hostStatusEl, '已建房，等待对手…'),
      onMessage: onLanMessage,
      onClose: () => {
        setStatus(hostStatusEl, '连接已断开，点「建房等待对手」重试', 'err');
        state.peerReady = false;
        paintMenuSelection();
      },
      onError: () => setStatus(hostStatusEl, '建房失败，点按钮重试', 'err'),
    });
  } catch (err) {
    setStatus(hostStatusEl, `建房失败：${err?.message ?? err}`, 'err');
  }
}

function openGuest() {
  closeLink();
  const addr = hostAddrEl.value.trim();
  if (!addr) {
    setStatus(guestStatusEl, '请先填房主地址', 'err');
    return;
  }
  setStatus(guestStatusEl, '正在连接…');
  delete guestStatusEl.dataset.failed;
  try {
    state.link = connectAsGuest(addr, joinRoomEl.value.trim() || null, {
      onOpen: () => setStatus(guestStatusEl, '已连接，等待房主开始…', 'ok'),
      onMessage: onLanMessage,
      onClose: () => {
        // 已经有明确的失败原因就别覆盖掉，否则用户看不到真正有用的排障信息
        if (guestStatusEl.dataset.failed === '1') return;
        setStatus(guestStatusEl, '连接已断开，点按钮重试', 'err');
        state.peerReady = false;
        paintMenuSelection();
      },
      onError: () => {
        guestStatusEl.dataset.failed = '1';
        setStatus(guestStatusEl, '连不上，检查地址 / WiFi / 防火墙', 'err');
      },
    });
  } catch (err) {
    guestStatusEl.dataset.failed = '1';
    setStatus(guestStatusEl, `连接失败：${err?.message ?? err}`, 'err');
  }
}

/** 联机消息分发 */
function onLanMessage(msg) {
  switch (msg.t) {
    case 'welcome': {
      state.linkSide = msg.side;
      state.room = msg.room;
      roomCodeEl.textContent = msg.room;
      if (state.mode === 'host') {
        setStatus(hostStatusEl, `房间 ${msg.room} · 等待对手…`);
      } else {
        // 客机也要看到自己进的是哪间房，方便核对房主报的号
        setStatus(guestStatusEl, `已进入房间 ${msg.room}，等待房主开始…`, 'ok');
      }
      break;
    }
    case 'room': {
      state.peerReady = Boolean(msg.full) || state.mode === 'guest';
      if (state.mode === 'host') {
        setStatus(hostStatusEl, msg.full ? '对手已进入房间' : '等待对手…', msg.full ? 'ok' : '');
      }
      paintMenuSelection();
      break;
    }
    case 'start': {
      startLanGame();
      break;
    }
    case 'move': {
      // 服务端广播 + 已应用的着法：本地落地并推进动画。
      // 注意服务端紧接着还会发一条 state，那条**只用来校正轮次/胜负**，
      // 绝不能再把着法应用一次。
      applyRemoteMove(msg);
      break;
    }
    case 'state': {
      syncRemoteState(msg);
      break;
    }
    case 'over': {
      state.over = true;
      paintHud();
      break;
    }
    case 'peer-left': {
      state.peerReady = false;
      if (state.mode === 'host') setStatus(hostStatusEl, '对手已离开', 'err');
      else setStatus(guestStatusEl, '房主已离开', 'err');
      // 对局进行中掉线必须有**看得见**的提示，光写进菜单里的状态没人看得到
      if (state.game && !state.over) {
        state.over = true;
        paintHud();
        showPeerLeft();
      }
      break;
    }
    case 'error': {
      if (msg.error === 'room-full') {
        setStatus(guestStatusEl, '这个房间已经满员了', 'err');
      } else if (msg.error === 'room-not-found') {
        setStatus(guestStatusEl, `房间 ${msg.room ?? ''} 不存在，请核对房主屏幕上的房间号`, 'err');
        state.peerReady = false;
        paintMenuSelection();
      }
      break;
    }
    case 'reject': {
      // 服务端拒绝了这一步（非法着法 / 非本方回合 / 对局已结束）
      // 以前这里没有分支，玩家点了没反应、完全不知道发生了什么
      const why = {
        illegal: '这一步不合法',
        'not-your-turn': '还没轮到你',
        'not-playing': '对局还没开始或已经结束',
      }[msg.error] ?? msg.error;
      flashBanner(why);
      // 以服务端为准把局面校正回来
      state.view.selected = null;
      state.view.targets = new Set();
      refreshView({ animate: false });
      paintHud();
      break;
    }
    default:
      break;
  }
}

function bindControls() {
  startBtn.addEventListener('click', () => {
    // 点一下就把整条链路包起来，任何异常都落到面板上，绝不静默失败
    void (async () => {
      try {
        if (state.mode === 'host') {
          // 已经连上对手就直接开局
          if (state.peerReady) {
            state.link?.send({ t: 'start', level: state.levelId });
          } else if (!state.link) {
            // 还没建房才建
            await openHost();
          } else {
            // 房间已经开好了：**复用**它，绝不另开一间，
            // 否则原来等在这间房里的人会被永远晾着
            roomCodeEl.textContent = state.room ?? '···';
            setStatus(hostStatusEl, `房间 ${state.room ?? ''} · 等待对手…`);
            flashBanner('房间已开好，把地址和房间号发给朋友');
          }
          return;
        }
        if (state.mode === 'guest') {
          openGuest();
          return;
        }
        if (hotseatChk.checked) await startHotseat();
        else await startGame();
      } catch (err) {
        console.error('[按钮处理失败]', err);
        window.__kardsErr = String(err && (err.stack || err.message || err));
        if (state.mode === 'host') setStatus(hostStatusEl, `建房失败：${err?.message ?? err}`, 'err');
        else if (state.mode === 'guest') setStatus(guestStatusEl, `连接失败：${err?.message ?? err}`, 'err');
        else menuHint.textContent = `开局失败：${err?.message ?? err}`;
      }
    })();
  });

  copyUrlBtn?.addEventListener('click', async () => {
    const text = `${lanUrlEl.textContent}`.trim();
    try {
      await navigator.clipboard.writeText(text);
      copyUrlBtn.textContent = '已复制';
      setTimeout(() => (copyUrlBtn.textContent = '复制'), 1400);
    } catch {
      copyUrlBtn.textContent = '手动复制';
    }
  });

  hotseatChk?.addEventListener('change', paintMenuSelection);

  bindResize();
}

/**
 * 尺寸变化时重算棋盘。
 *
 * 手机上"电脑端正常、手机端溢出"的根因就在这里：只监听 window 的 resize
 * 是不够的 ——
 *   - 地址栏收起/弹出改变可视高度，不一定触发 resize → 监听 visualViewport
 *   - orientationchange 触发时布局尚未完成，量到的是旧尺寸 → 延后重算
 *   - 字体/图片加载完也会让布局落定 → load 事件再算一次
 * 所以这里统一用一个防抖重算，并在几个时机都补一次。
 */
function bindResize() {
  let timer = 0;
  const remeasure = () => {
    clearTimeout(timer);
    // 立即按当前值算一次，再延后补一次（等布局真正落定）
    measureAndResize();
    timer = setTimeout(measureAndResize, 180);
    timer = setTimeout(() => {
      measureAndResize();
    }, 450);
  };

  window.addEventListener('resize', remeasure);
  window.addEventListener('orientationchange', remeasure);
  window.addEventListener('pageshow', remeasure);
  // 动态视口：地址栏、软键盘
  window.visualViewport?.addEventListener('resize', remeasure);
  window.visualViewport?.addEventListener('scroll', remeasure);
  // 首次布局落定后再算一次，别让"刚建好时量到的错尺寸"留下来
  window.addEventListener('load', remeasure);
  remeasure();
}

/** 按 HUD / 版权声明的实际高度给画布留出空间，然后重算 */
function measureAndResize() {
  const view = state.view;
  if (!view) return;
  const h = (el) => (el && !el.hidden ? el.getBoundingClientRect().height : 0);
  const noticeEl = document.getElementById('licenseNotice');

  // 浮层让位分两套，各管一段，别重复计算：
  //   - CSS padding（--hud-top / --hud-bottom）：把**内容区**从浮层中间让出来，
  //     保证 flex 居中不会把画布推到 HUD 下面
  //   - view.reserveTop / reserveBottom：从**可用高度**里扣掉浮层与版权声明，
  //     保证画布自身尺寸不越过它们
  // 两套都设置时总高会偏小一点（画布略小），但绝不会被压住 —— 这条优先。
  // +18 的余量是给 flex 居中取整的：只留 10px 时实测会差 1px 蹭上。
  const GAP = 18;
  const root = document.documentElement.style;
  const hudH = h(hud);
  const botH = h(hudBottom);
  root.setProperty('--hud-top', `${Math.round(hudH) + GAP}px`);
  root.setProperty('--hud-bottom', `${Math.round(botH) + GAP}px`);
  view.reserveTop = hudH + GAP;
  view.reserveBottomBase = botH + 10;

  // 版权声明是**固定**贴在视口最底层的浮层，高度只取决于视口宽度。
  // 从可用高度里把它扣掉，画布就不会伸到它下面去。
  const noticeH = h(noticeEl);
  view.reserveBottom = noticeH + 14;
  view.resize();
  // 底部头像抬到版权声明之上，两者永不重叠
  root.setProperty('--notice-h', `${Math.round(noticeH) + 8}px`);

  // 夹取用的是新布局，把落点重新算一遍
  if (state.game) view.sync(state.game.state.board, { animate: false });
  paintHud();
}

/* ---------------- 对局 ---------------- */

function cardMapFor(sides) {
  const map = {};
  for (const side of sides) {
    const fid = side === RED ? SOVIET : GERMANY;
    map[side] = FACTIONS[fid].cards;
  }
  return map;
}

async function startGame() {
  try {
    await startGameInner();
  } catch (err) {
    console.error('[开局失败]', err);
    window.__kardsErr = String(err && (err.stack || err.message || err));
    menuEl.hidden = false;
    menuHint.textContent = `开局失败：${err?.message ?? err}`;
  }
}

async function startGameInner() {
  const humanSide = sideOfFaction(state.factionId);
  await beginMatch({ humanSide, mode: 'local' });

  // 单人模式：若玩家执黑，引擎先行
  const aiSide = humanSide === RED ? BLACK : RED;
  if (state.game.state.turn === aiSide) scheduleAiMove(500);
}

/**
 * 建立棋盘视图并开一局（单人 / 同机双人 / 联机共用）。
 * @param {{humanSide:'red'|'black', mode:'local'|'hotseat'|'lan'}} opts
 */
async function beginMatch({ humanSide, mode }) {
  state.playMode = mode;
  const aiSide = humanSide === RED ? BLACK : RED;

  menuHint.textContent = '载入素材…';
  await ensureAssets([FACTIONS[SOVIET], FACTIONS[GERMANY]], preload, urlsForFactions);

  if (!state.view) {
    state.view = new BoardView(canvas, { humanSide, factionCards: cardMapFor([RED, BLACK]) });
  }
  state.view.humanSide = humanSide;
  state.view.sprites.clear();
  state.view.fallen = [];
  state.view.selected = null;
  state.view.targets = new Set();
  state.view.checkSide = null;

  state.humanSide = humanSide;
  state.aiSide = aiSide;
  state.game = { state: initialState(), history: [], lastMove: null };
  state.over = false;
  state.aiThinking = false;

  menuEl.hidden = true;
  resultEl.hidden = true;
  hud.hidden = false;
  paintHud();
  // ⚠️ 必须在这里再算一次尺寸：建 view 的时候 HUD 还是隐藏的，
  //    那时量到的高度是 0，留白就不够，底部头像会盖住棋盘最后一行。
  //    HUD 显示后、（尤其 hudBottom 的显隐改变后）都要重算。
  measureAndResize();
  refreshView({ animate: false });
}

/** 联机：房主点了开始，双方各自进入对局 */
async function startLanGame() {
  const side = state.linkSide ?? (state.mode === 'host' ? RED : BLACK);
  await beginMatch({ humanSide: side, mode: 'lan' });
  paintHud();
}

/** 联机：收到对方（或服务端广播）的一步棋 */
function applyRemoteMove(msg) {
  const { game, view } = state;
  if (!game) return;
  const captured = game.state.board[msg.to];
  const mover = game.state.board[msg.from];
  if (!mover) return;
  if (captured) {
    view.playDeath(captured.side, captured.type, msg.to, performance.now());
  }
  applyAndAdvance(msg.from, msg.to, mover, captured, { fromRemote: true });
}

/**
 * 联机：以服务端为准校正轮次。
 * 服务端在每条 move 之后都会跟一条 state；着法已经在 applyRemoteMove 里落地了，
 * 所以这里**只同步轮次与胜负**，不碰棋盘，否则同一着会被应用两次。
 */
function syncRemoteState(msg) {
  if (!state.game || state.playMode !== 'lan') return;
  let changed = false;
  if (state.game.state.turn !== msg.turn) {
    state.game.state.turn = msg.turn;
    changed = true;
  }
  const st = gameStatus(state.game.state);
  if (msg.over && !state.over) {
    endGame({ over: true, winner: msg.winner, reason: msg.reason });
    return;
  }
  if (changed || st.checked) {
    refreshView({ animate: false });
    paintHud();
  }
}

let assetsReady = false;
async function ensureAssets(factions, preload, urlsForFactions) {
  if (assetsReady) return;
  await preload(urlsForFactions(factions), (done, total) => {
    menuHint.textContent = `载入素材… ${Math.round((done / total) * 100)}%`;
  });
  assetsReady = true;
}

/** 把引擎局面同步到视图 */
function refreshView({ animate = true } = {}) {
  const { game, view } = state;
  if (!game || !view) return;
  view.sync(game.state.board, { animate });
  // 标记上一手：让玩家一眼看出对方刚把哪个子挪到哪去了。
  // 用 game.lastMove（不是 moves 的末条）——悔棋后它会自动回退到上一步，
  // 不会把已经撤销的那步留在盘上误导人。
  const lm = game.lastMove;
  view.markLastMove(lm ? lm.from : null, lm ? lm.to : null);
  view.checkSide = isInCheck(game.state.board, game.state.turn) ? game.state.turn : null;
  const gid = {};
  gid[RED] = findGeneral(game.state.board, RED);
  gid[BLACK] = findGeneral(game.state.board, BLACK);
  view._generalId = gid;

  const st = gameStatus(game.state);
  if (st.over) endGame(st);
}

function paintHud() {
  const humanFid = state.humanSide === RED ? SOVIET : GERMANY;
  const aiFid = state.aiSide === RED ? SOVIET : GERMANY;
  const aiCfg = FACTIONS[aiFid];
  const selfCfg = FACTIONS[humanFid];
  const lv = DIFFICULTY_UI.find((l) => l.id === state.levelId);

  const lan = state.playMode === 'lan';
  const hotseat = state.playMode === 'hotseat';
  // 棋盘默认红在下；执黑时整盘转 180°，于是"上方"变成红方
  const flipped = state.humanSide === BLACK;

  /* ---- 左上：显示在棋盘上方的那一方 ---- */
  const topCfg = flipped ? FACTIONS[SOVIET] : aiCfg;
  hudTopAvatar.src = `./assets/${topCfg.portrait}`;
  // 头像永远朝向玩家，不跟着棋盘转
  hudTopAvatar.style.transform = '';
  const topLabel = lan || hotseat ? '对手' : '敌方';
  const topWho = flipped ? (lan || hotseat ? '红方' : '敌方') : topLabel;
  hudTopName.textContent = `${topWho} · ${topCfg.name}`;
  hudTopSub.textContent = lan
    ? `${topCfg.subtitle} · 局域网玩家`
    : hotseat
      ? `${topCfg.subtitle} · 同机玩家`
      : `${topCfg.subtitle} · ${lv.name}`;

  /* ---- 左下：玩家自己（同机模式用来指示该谁走）---- */
  // 显隐变化会改变要给浮层留的高度，所以变化后要重算尺寸。
  // 用 rAF 延后，避免 paintHud ↔ measureAndResize 互相递归。
  const bottomWasHidden = hudBottom.hidden;
  hudBottom.hidden = !hotseat;
  if (hudBottom.hidden !== bottomWasHidden) scheduleRemeasure();
  if (hotseat) {
    // 同机时下方永远是"先手方"（红），因为棋盘就是红在下
    const bottomCfg = FACTIONS[SOVIET];
    hudSelfAvatar.src = `./assets/${bottomCfg.portrait}`;
    hudSelfAvatar.style.transform = '';
    hudSelfName.textContent = `红方 · ${bottomCfg.name}`;
    hudSelfSub.textContent = `${bottomCfg.subtitle} · 同机玩家`;
  }

  /* ---- 该谁走：对应那一侧头像亮起 ---- */
  const turn = state.game?.state.turn;
  // 上方是红方 ⇔ 棋盘被翻转过
  const topIsRed = flipped;
  const topTurn = turn === RED ? topIsRed : !topIsRed;
  const active = !state.over;
  hudTopEl.classList.toggle('active', active && topTurn);
  hudTopEl.classList.toggle('dim', active && !topTurn);
  if (hotseat) {
    hudSelfEl.classList.toggle('active', active && !topTurn);
    hudSelfEl.classList.toggle('dim', active && topTurn);
  }

  const mine = turn === state.humanSide;
  const who = turn === RED ? '红方' : '黑方';
  turnText.textContent = state.over
    ? '对局结束'
    : lan
      ? `${who}走棋${mine ? '（你）' : '（对手）'}`
      : hotseat
        // 同机：直接报"该谁走 + 那一方的阵营名"。
        // 阵营名必须由 turn 决定（红=莫斯科、黑=柏林），
        // 之前误用了 topTurn，导致文字与亮起的头像永远相反。
        ? `${who}走棋 · ${turn === RED ? FACTIONS[SOVIET].name : FACTIONS[GERMANY].name}`
        : `${who}走棋${mine ? '（你）' : ''}`;
  turnDot.className = `turn-dot${turn === BLACK ? ' black' : ''}${state.over ? ' over' : ''}`;
  if (undoBtn) undoBtn.disabled = state.playMode === 'lan';
  void humanFid;
  void selfCfg;
}

/* ---------------- 交互 ---------------- */

canvas.addEventListener('pointerdown', (ev) => {
  if (!state.game || state.over || state.aiThinking) return;

  const hotseat = state.playMode === 'hotseat';
  const lan = state.playMode === 'lan';
  const turn = state.game.state.turn;
  // 同机双人：谁该走就操作谁；联机：只管自己那一方；单人：只管自己
  if (!hotseat && turn !== state.humanSide) return;
  if (lan && turn !== state.linkSide) return;

  const rect = canvas.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * state.view.layout.width;
  const py = ((ev.clientY - rect.top) / rect.height) * state.view.layout.height;
  const cell = state.view.snap(px, py);
  if (!cell) return;

  const id = idx(cell.file, cell.rank);
  const board = state.game.state.board;

  // 已经选中且点到可走点 → 走子
  if (state.view.selected != null && state.view.targets.has(id)) {
    doHumanMove(state.view.selected, id);
    return;
  }

  // 可以拿起的是"当前该走那一方"的棋子
  const controllable = hotseat || lan ? turn : state.humanSide;
  const piece = board[id];
  if (piece && piece.side === controllable) {
    state.view.selected = id;
    state.view.targets = new Set(
      legalMoves(state.game.state, controllable)
        .filter((m) => m.from === id)
        .map((m) => m.to),
    );
  } else {
    state.view.selected = null;
    state.view.targets = new Set();
  }
});

function doHumanMove(from, to) {
  const captured = state.game.state.board[to];
  const mover = state.game.state.board[from];
  if (captured) {
    state.view.playDeath(captured.side, captured.type, to, performance.now());
  }
  // 联机：先发给服务端，由服务端校验后广播；本地不抢先改局面
  if (state.playMode === 'lan') {
    const ok = state.link?.send({ t: 'move', from, to });
    if (ok) {
      state.view.selected = null;
      state.view.targets = new Set();
      return;
    }
  }
  applyAndAdvance(from, to, mover, captured);
}

function applyAndAdvance(from, to, mover, captured, { fromRemote = false } = {}) {
  const board = state.game.state.board;
  board[to] = mover;
  board[from] = null;
  const record = { from, to, mover, captured };
  state.game.history.push(record);
  // 给"上一手高亮"用；悔棋时下面会跟着回退
  state.game.lastMove = record;
  state.game.state.turn = state.game.state.turn === RED ? BLACK : RED;

  state.view.selected = null;
  state.view.targets = new Set();
  refreshView({ animate: true });
  paintHud();

  if (state.over || fromRemote) return;
  // 只有单人模式才轮引擎
  if (state.playMode !== 'hotseat' && state.playMode !== 'lan' && state.game.state.turn === state.aiSide) {
    scheduleAiMove(320);
  }
}

function scheduleAiMove(delay) {
  state.aiThinking = true;
  setTimeout(() => {
    if (!state.game || state.over) {
      state.aiThinking = false;
      return;
    }
    const level = LEVELS.find((l) => l.id === state.levelId) ?? LEVELS[1];
    const move = chooseMove(state.game.state, { ...level, random: level.random });
    state.aiThinking = false;
    if (!move) {
      refreshView();
      return;
    }
    const captured = state.game.state.board[move.to];
    const mover = state.game.state.board[move.from];
    if (captured) {
      state.view.playDeath(captured.side, captured.type, move.to, performance.now());
    }
    applyAndAdvance(move.from, move.to, mover, captured);
  }, delay);
}

undoBtn?.addEventListener('click', () => {
  if (state.over || state.aiThinking) return;
  // 联机局面以服务端为准，本地悔棋没有意义
  if (state.playMode === 'lan') return;
  const g = state.game;
  // 回退到玩家上一次走子之前（通常回退两步：引擎一步 + 玩家一步）
  const steps = g.state.turn === state.humanSide ? 2 : 1;
  for (let i = 0; i < steps; i++) {
    const rec = g.history.pop();
    if (!rec) break;
    g.state.board[rec.from] = rec.mover;
    g.state.board[rec.to] = rec.captured ?? null;
    g.state.turn = rec.mover.side;
  }
  // 上一手标记跟着回退到剩下的最后一步（全悔完就清空）
  g.lastMove = g.history[g.history.length - 1] ?? null;
  state.view.selected = null;
  state.view.targets = new Set();
  refreshView({ animate: false });
  paintHud();
});

menuBtn?.addEventListener('click', () => {
  clearResultTimer();
  if (bannerEl) bannerEl.hidden = true;
  state.game = null;
  state.over = false;
  hud.hidden = true;
  hudBottom.hidden = true;
  resultEl.hidden = true;
  menuEl.hidden = false;
  if (state.view) {
    state.view.sprites.clear();
    state.view.fallen = [];
    state.view.selected = null;
    state.view.targets = new Set();
  }
  paintMenuSelection();
});

/* ---------------- 结算 ---------------- */

function endGame(st) {
  state.over = true;
  state.view.selected = null;
  state.view.targets = new Set();
  state.view.checkSide = null;
  paintHud();

  // 被将死的一方：将/帅变红 → 顺时针 90° 倒地
  const loser = st.winner === RED ? BLACK : RED;
  const gid = findGeneral(state.game.state.board, loser);
  if (gid >= 0 && st.reason === 'checkmate') {
    const type = state.game.state.board[gid]?.type ?? 'general';
    state.view.killGeneral(loser, type, gid, performance.now());
  }

  const humanWon = st.winner === state.humanSide;
  const winnerName = st.winner === RED ? '红方 · 莫斯科' : '黑方 · 柏林';
  const reasonText =
    st.reason === 'checkmate' ? '将死' : st.reason === 'stalemate' ? '困毙（无子可走）' : '结束';

  // 等翻倒动画演完再弹结算；这个定时器必须可取消，
  // 否则玩家在动画期间点"菜单"，过期的结算面板会盖到菜单上
  clearResultTimer();
  resultTimer = setTimeout(() => {
    resultTimer = 0;
    resultBadge.textContent = humanWon ? '胜' : '负';
    resultBadge.classList.toggle('lose', !humanWon);
    resultTitle.textContent = humanWon ? '你赢了' : '你输了';
    resultReason.textContent = `${winnerName} 获胜 · ${reasonText}`;
    resultEl.hidden = false;
  }, st.reason === 'checkmate' ? 1550 : 300);
}

againBtn.addEventListener('click', () => {
  if (state.playMode === 'lan') {
    // 联机重开由房主发起，双方一起重置
    if (state.mode === 'host') state.link?.send({ t: 'rematch', level: state.levelId });
    return;
  }
  if (state.playMode === 'hotseat') {
    beginMatch({ humanSide: RED, mode: 'hotseat' });
    return;
  }
  startGame();
});
backBtn.addEventListener('click', () => {
  clearResultTimer();
  if (bannerEl) bannerEl.hidden = true;
  resultEl.hidden = true;
  state.game = null;
  state.over = false;
  hud.hidden = true;
  hudBottom.hidden = true;
  menuEl.hidden = false;
  paintMenuSelection();
});

/** "同一台设备"：红黑双方都由人来操作 */
async function startHotseat() {
  await beginMatch({ humanSide: RED, mode: 'hotseat' });
  paintHud();
}

/* ---------------- 主循环 ---------------- */

function loop(now) {
  const { view } = state;
  if (view) {
    // 计时目前只用于展示（HUD 没显示读秒），
    // 所以这里**不能**因为本地钟归零就自行判负 —— 联机时服务端没有时钟逻辑，
    // 本地判负会让双方局面永久分叉。等到真的做计时功能时，
    // 必须由服务端权威判定并广播 over。
    view.render(now);
  }
  requestAnimationFrame(loop);
}

/* ---------------- 启动 ---------------- */

/** 挂载：等 DOM 就绪再绑事件，避免脚本在 <head> 或被过早执行时找不到元素 */
function boot() {
  bindControls();
  buildMenu();

  // 测试用：?faction=soviet&level=2&auto=1 直接开局
  const params = new URLSearchParams(location.search);
  const qf = params.get('faction');
  if (qf && FACTIONS[qf]) {
    state.factionId = qf;
    const ql = Number(params.get('level'));
    if (ql >= 1 && ql <= 4) state.levelId = ql;
    paintMenuSelection();
    if (params.get('auto') === '1') startGame();
  }

  requestAnimationFrame(loop);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// 供无头测试使用
if (typeof window !== 'undefined') window.__kards = { state, startGame, buildMenu, refreshView };

export { state, startGame, buildMenu, refreshView };
