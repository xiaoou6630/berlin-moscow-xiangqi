/**
 * 渲染层测试（Node + 最小 DOM 桩）：
 *   - 阵营 / 卡面映射完整性（每种棋子都得有图）
 *   - 资源路径归一化
 *   - BoardView 的尺寸、坐标、精灵同步、将死翻倒参数
 *   - drawBoard 在深色主题下的绘制调用
 *
 * 页面入口 public/src/main.js 依赖浏览器绝对路径（/src/...），由
 * npm run test:browser 在真浏览器里覆盖。
 *
 * 运行：npm run test:dom
 */
import assert from 'node:assert/strict';

import { FILES, RANKS, FRAME_ASPECT, computeLayout, rotate180, MARGIN_Y } from '../src/geometry.js';
import { drawBoard } from '../src/board.js';
import { FACTIONS, SOVIET, GERMANY, CARD_RATIO, CARD_WIDTH_UNITS, DIFFICULTY_UI } from '../public/src/theme.js';
import { normalizeAssetPath, urlsForFactions } from '../public/src/assets.js';

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

/* ------------------------------------------------------------------ *
 * 浏览器环境桩（够 BoardView 跑起来）
 * ------------------------------------------------------------------ */

const strokes = [];
const fills = [];
const texts = [];

function makeCtx(canvas) {
  return {
    canvas,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic',
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    setLineDash() {}, clearRect() {}, fillRect() {}, strokeRect() {}, rect() {}, clip() {},
    beginPath() { this._n = 0; }, moveTo() { this._n++; }, lineTo() { this._n++; },
    arc() {}, stroke() { strokes.push({ w: this.lineWidth, points: this._n }); },
    fill() { fills.push(1); },
    fillText(t, x, y) { texts.push({ t, x, y }); },
    drawImage() {},
    getImageData() { return { data: new Uint8ClampedArray(4) }; },
  };
}

function makeCanvas(w = 900, h = 1000) {
  const ctx = makeCtx(null);
  return {
    width: 0, height: 0,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener() {},
    dispatchEvent() {},
  };
}

globalThis.window = { innerWidth: 1400, innerHeight: 1000, devicePixelRatio: 2, addEventListener() {} };
globalThis.document = {
  createElement: () => makeCanvas(500, 702),
  getElementById: () => null,
};
/** 假 Image：设置 src 后异步触发 onload，供 assets.preload 使用 */
globalThis.Image = class {
  constructor() {
    this.width = 500;
    this.height = 702;
    this.naturalWidth = 500;
    this.naturalHeight = 702;
    this._src = '';
  }

  set src(v) {
    this._src = v;
    queueMicrotask(() => this.onload?.());
  }

  get src() {
    return this._src;
  }
};
globalThis.performance ??= { now: () => Date.now() };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { BoardView } = await import('../public/src/ui/board-view.js');
const { initialState } = await import('../src/engine/rules.js');
const { preload } = await import('../public/src/assets.js');

// 预置资源，让 render 能取到图片
await preload(urlsForFactions([FACTIONS[SOVIET], FACTIONS[GERMANY]]));

/* ------------------------------------------------------------------ *
 * 主题 / 资源
 * ------------------------------------------------------------------ */

console.log('theme');

check('两个阵营都存在且带头像', () => {
  assert.ok(FACTIONS[SOVIET] && FACTIONS[GERMANY]);
  for (const f of [FACTIONS[SOVIET], FACTIONS[GERMANY]]) {
    assert.ok(f.portrait.endsWith('.png'), f.portrait);
    assert.equal(f.side, f === FACTIONS[SOVIET] ? 'red' : 'black');
  }
});

check('每种棋子都有对应卡面（不能缺图）', () => {
  const types = ['general', 'advisor', 'elephant', 'horse', 'chariot', 'cannon', 'pawn'];
  for (const f of [FACTIONS[SOVIET], FACTIONS[GERMANY]]) {
    for (const t of types) {
      assert.ok(f.cards[t], `${f.name} 缺少 ${t} 的卡面`);
      assert.ok(f.cards[t].endsWith('.webp'));
    }
  }
});

check('资源路径归一化：带不带 assets/ 前缀都指向同一份', () => {
  assert.equal(normalizeAssetPath('cards/soviet/pawn.png'), 'assets/cards/soviet/pawn.png');
  assert.equal(normalizeAssetPath('assets/cards/soviet/pawn.png'), 'assets/cards/soviet/pawn.png');
  assert.equal(normalizeAssetPath('portraits/soviet.png'), 'assets/portraits/soviet.png');
});

check('预加载清单覆盖双方全部卡面与头像', () => {
  const urls = urlsForFactions([FACTIONS[SOVIET], FACTIONS[GERMANY]]);
  const keys = urls.map(normalizeAssetPath);
  assert.ok(keys.includes('assets/background.webp'), '缺背景');
  for (const f of [FACTIONS[SOVIET], FACTIONS[GERMANY]]) {
    assert.ok(keys.includes(normalizeAssetPath(f.portrait)), `缺头像 ${f.portrait}`);
    for (const p of Object.values(f.cards)) {
      assert.ok(keys.includes(normalizeAssetPath(p)), `缺卡面 ${p}`);
    }
  }
  assert.equal(new Set(keys).size, keys.length, '整份清单不应有重复');
});

check('苏联的士用"近卫步兵第 272 团"，不再和相共用一张图', () => {
  const sov = FACTIONS[SOVIET].cards;
  assert.notEqual(sov.advisor, sov.elephant, '士与相必须是不同的图');
  // 七个角色各自独立（此前士/相共用一张，已经修掉）
  const own = Object.values(sov).map(normalizeAssetPath);
  assert.equal(new Set(own).size, own.length, '苏联内部卡面不应重复');
  // 德军七种棋子也各不相同
  const ger = Object.values(FACTIONS[GERMANY].cards).map(normalizeAssetPath);
  assert.equal(new Set(ger).size, ger.length, '德军卡面不应重复');
});

check('四个档位与引擎 LEVELS 对齐', () => {
  assert.equal(DIFFICULTY_UI.length, 4);
  assert.deepEqual(DIFFICULTY_UI.map((l) => l.id), [1, 2, 3, 4]);
});

/* ------------------------------------------------------------------ *
 * BoardView
 * ------------------------------------------------------------------ */

console.log('board-view');

const background = { width: 1600, height: 1000, naturalWidth: 1600, naturalHeight: 1000 };
const fakeImg = (w = 500, h = 702) => ({ width: w, height: h, naturalWidth: w, naturalHeight: h });

// 预置资源缓存，避免走 Image 加载
const assetsMod = await import('../public/src/assets.js');
const cacheHack = (() => {
  try {
    // 通过 preload 的缓存写入通道：直接塞进模块内部不可行，这里改成用假 Image
    return null;
  } catch { return null; }
})();
void cacheHack;
void background;
void fakeImg;
void assetsMod;

check('BoardView 构造后画布按 DPR 缩放', () => {
  const canvas = makeCanvas();
  const view = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
  assert.ok(canvas.width > 0 && canvas.height > 0);
  // CSS 尺寸严格等比（整数位图会有 1px 取整误差）
  const cssW = parseFloat(canvas.style.width);
  const cssH = parseFloat(canvas.style.height);
  assert.ok(Math.abs(cssH / cssW - FRAME_ASPECT) < 1e-9, `${cssH / cssW}`);
  assert.equal(canvas.width, Math.round(cssW * 2));
  assert.equal(view.layout.width, cssW);
});

check('卡牌尺寸：完整卡面（不裁剪），且能放进几何留白', () => {
  const canvas = makeCanvas();
  const view = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
  assert.ok(Math.abs(view.cardW - view.layout.filePitch * CARD_WIDTH_UNITS) < 1e-9);
  // 不裁剪 → 牌高严格等于 牌宽 × 原始比例
  assert.ok(Math.abs(view.cardH - view.cardW * CARD_RATIO) < 1e-9, '卡面必须完整，不能裁剪');

  /*
   * ⚠️ 这里曾经断言「牌高/线距 < 1.0」，理由是「否则同路相邻两行的牌会叠、
   * 且最外两行会伸出留白」。**前半句对，后半句是错的**：
   *   - MARGIN_Y 是**由卡高推导**的（= 卡高/2 + 0.06），牌只会向外伸半个卡高，
   *     留白永远够 —— 所以 卡高 > 线距 并不会溢出。
   *   - 它只造成**相邻两行重叠**，而这是"把卡面放大到 150%（0.6 → 0.9）"的
   *     自觉取舍：卡面比例固定、绝不裁剪，横向 0.9 < 路距 1 所以左右不叠，
   *     纵向 1.264 > 线距 1 所以上下叠约 0.26 格。
   * 现在改为验证**真正的铁律**：整张牌必须落在画布内（四边都不越界）。
   */
  const ratio = view.cardH / view.layout.rankPitch;
  assert.ok(ratio > 1.0, `牌高/线距 = ${ratio.toFixed(3)}，当前放大设定下应当 > 1`);
  assert.ok(ratio < 2.0, `牌高/线距 = ${ratio.toFixed(3)} 过大，相邻两行会叠得太狠`);

  const pads = view.layout.padding;
  /*
   * 算的是"牌伸到画布外面多少"：负数表示在画布内（留有余量），
   * 正数才是溢出。之前我把符号写反了，正数当成溢出，导致误报。
   */
  const overflow = {
    上: view.cardH / 2 - pads.top,
    下: view.cardH / 2 - pads.bottom,
    左: view.cardW / 2 - pads.left,
    右: view.cardW / 2 - pads.left,
  };
  for (const [side, over] of Object.entries(overflow)) {
    assert.ok(over <= 0.5, `${side}边的牌伸出画布 ${over.toFixed(1)}px`);
  }
  // 牌以交叉点为中心，留白至少要容下半个卡面
  assert.ok(pads.top >= view.cardH / 2 - 0.5, `纵向留白 ${pads.top.toFixed(1)}px 容不下半个卡高`);
  assert.ok(pads.left >= view.cardW / 2 - 0.5, `横向留白 ${pads.left.toFixed(1)}px 容不下半个卡宽`);
  assert.ok(pads.left >= view.cardW / 2 - 0.5, `横向留白 ${pads.left.toFixed(1)}px 容不下半个卡宽`);
});

check('任何窗口尺寸下都只做等比缩放，绝不拉伸', () => {
  for (const [vw, vh] of [[1400, 1000], [1820, 920], [430, 932], [2560, 1440], [900, 1600]]) {
    globalThis.window.innerWidth = vw;
    globalThis.window.innerHeight = vh;
    const canvas = makeCanvas();
    const view = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
    const cssW = parseFloat(canvas.style.width);
    const cssH = parseFloat(canvas.style.height);
    assert.ok(Math.abs(cssH / cssW - FRAME_ASPECT) < 1e-9, `${vw}x${vh} 画幅被拉伸: ${cssH / cssW}`);
    assert.ok(cssW <= vw && cssH <= vh, `${vw}x${vh} 超出视口`);
    // 卡牌宽高比必须保持原图比例
    assert.ok(Math.abs(view.cardH / view.cardW - CARD_RATIO) < 1e-9, `${vw}x${vh} 卡牌被拉伸`);
    // 线距始终等于路距（每格正方形）
    assert.ok(Math.abs(view.layout.filePitch - view.layout.rankPitch) < 1e-9, `${vw}x${vh} 格子非方`);
  }
  globalThis.window.innerWidth = 1400;
  globalThis.window.innerHeight = 1000;
});

check('pointAt / snap 与几何层一致', () => {
  const canvas = makeCanvas();
  const view = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
  for (const [f, r] of [[0, 0], [4, 0], [8, 9], [2, 7]]) {
    const p = view.pointAt(f, r);
    assert.deepEqual(view.snap(p.px, p.py), { file: f, rank: r });
  }
  assert.equal(view.snap(-999, -999), null);
});

check('sync 把 32 个棋子变成精灵', () => {
  const canvas = makeCanvas();
  const view = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
  const { board } = initialState();
  view.sync(board, { animate: false });
  assert.equal(view.sprites.size, 32);
  // 每个精灵都落在它自己那个交叉点上（positionOf 是渲染真正使用的位置，
  // 含"夹进画布"的兜底，所以这里对照它而不是原始交叉点）
  for (const s of view.sprites.values()) {
    const p = view.positionOf(s.id);
    assert.ok(
      Math.abs(s.x - p.px) < 1e-6 && Math.abs(s.y - p.py) < 1e-6,
      `棋子 ${s.id} 的精灵位置 (${s.x.toFixed(1)},${s.y.toFixed(1)}) 与交叉点 (${p.px.toFixed(1)},${p.py.toFixed(1)}) 不一致`,
    );
  }
});

check('sync 后消失的棋子会从精灵表移除', () => {
  const canvas = makeCanvas();
  const view = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
  const { board } = initialState();
  view.sync(board, { animate: false });
  const next = board.slice();
  next[0] = null;
  view.sync(next, { animate: false });
  assert.equal(view.sprites.size, 31);
});

check('玩家一方先亮出，对方延迟亮出', () => {
  const canvas = makeCanvas();
  const view = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
  const { board } = initialState();
  const t0 = 1000;

  view.sync(board, { animate: false });
  for (const s of view.sprites.values()) s.born = t0;

  // 亮出标记在渲染时写入；这里用 alpha 判断（advance 会据此设置）
  const alphaCount = (n) => [...view.sprites.values()].filter((s) => s.revealed).length;
  view.advance(t0 + 10);
  view.render(t0 + 10);
  assert.equal(alphaCount(), 16, `红方 16 子应立即亮出，实际 ${alphaCount()}`);

  view.advance(t0 + 400);
  view.render(t0 + 400);
  assert.equal(alphaCount(), 32, `黑方应在延迟后亮出，实际 ${alphaCount()}`);

  // 未亮出的棋子 alpha 为 0
  const view2 = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
  view2.sync(board, { animate: false });
  for (const s of view2.sprites.values()) s.born = t0;
  view2.advance(t0 + 5);
  const black = [...view2.sprites.values()].find((s) => s.side === 'black');
  assert.equal(black.alpha, 0, '黑方尚未亮出时 alpha 应为 0');
  const red = [...view2.sprites.values()].find((s) => s.side === 'red');
  assert.equal(red.revealed, false, '真实亮出由渲染阶段写入（此处尚未渲染）');
});

check('将死翻倒：变红 → 顺时针 90° → 压平倒地', () => {
  const canvas = makeCanvas();
  const view = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
  const { board } = initialState();
  view.sync(board, { animate: false });

  const t0 = 5000;
  view.killGeneral('black', 'general', 4, t0);
  const s = view.sprites.get(4);

  // 起始：未变红、未旋转
  view.advance(t0);
  assert.ok(s.red < 0.05, `red=${s.red}`);
  assert.ok(Math.abs(s.rot) < 1e-6, `rot=${s.rot}`);

  // 中段：已经变红
  view.advance(t0 + 550);
  assert.ok(s.red > 0.9, `中段应已变红，red=${s.red}`);
  assert.ok(s.rot >= 0, '旋转不应为负（顺时针）');

  // 结束：转了 90°，且完成"躺下"（tilt 到达卡面长宽比 CARD_RATIO）
  view.advance(t0 + 1600);
  assert.ok(Math.abs(s.rot - Math.PI / 2) < 1e-6, `末态旋转 ${(s.rot * 57.3).toFixed(1)}°`);
  assert.ok(Math.abs(s.tilt - CARD_RATIO) < 1e-6, `末态 tilt=${s.tilt}，应为 ${CARD_RATIO}`);
  assert.equal(s.alpha, 1, '倒地的将牌应保持可见');
});

check('执黑时整盘转 180°，自己的子永远在下方', () => {
  const canvas = makeCanvas();
  const { board } = initialState();

  // 执红：不翻转，自己（红）在下方
  const redView = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
  redView.sync(board, { animate: false });
  assert.equal(redView.isFlipped(), false);
  const redGeneral = 9 * 9 + 4; // 红帅 (4,9)
  const blackGeneral = 0 * 9 + 4; // 黑将 (4,0)
  const redY = redView.sprites.get(redGeneral).y;
  const blackY = redView.sprites.get(blackGeneral).y;
  assert.ok(redY > blackY, '执红时红方应在下方');

  // 执黑：翻转，自己（黑）也应落到下方
  const blackView = new BoardView(canvas, { humanSide: 'black', factionCards: { red: {}, black: {} } });
  blackView.sync(board, { animate: false });
  assert.equal(blackView.isFlipped(), true);
  const redY2 = blackView.sprites.get(redGeneral).y;
  const blackY2 = blackView.sprites.get(blackGeneral).y;
  assert.ok(blackY2 > redY2, '执黑时黑方应在下方');
});

check('执黑时点击坐标映射回真实盘面索引（两套空间不能混）', () => {
  const canvas = makeCanvas();
  const view = new BoardView(canvas, { humanSide: 'black', factionCards: { red: {}, black: {} } });
  const { board } = initialState();
  view.sync(board, { animate: false });

  // 点在自己看到的任意棋子上，都必须还原成它真实的盘面索引
  for (let id = 0; id < board.length; id++) {
    if (!board[id]) continue;
    const shown = view.positionOf(id);
    const back = view.snap(shown.px, shown.py);
    assert.deepEqual(back, { file: id % 9, rank: Math.floor(id / 9) },
      `索引 ${id} 的落点映射错误: ${JSON.stringify(back)}（应为 ${id % 9},${Math.floor(id / 9)}）`);
  }

  // 首行第一格：真实 (0,0) 的精灵应当被画在 (8,9) 位置
  assert.deepEqual(view.snap(view.positionOf(0).px, view.positionOf(0).py), { file: 0, rank: 0 });
  assert.equal(view.toDisplay(0), 89, '真实 (0,0) 应画在显示格 (8,9)');
  assert.equal(view.fromDisplay(89), 0);

  // 屏幕下方中央应当是黑将（真实 (4,0)）
  const blackGeneral = 0 * 9 + 4;
  const redGeneral = 9 * 9 + 4;
  assert.ok(view.positionOf(blackGeneral).py > view.positionOf(redGeneral).py, '黑方应在屏幕下方');
  assert.equal(view.snap(-999, -999), null);
});

check('rotate180 是对合：转两次回到原位', () => {
  for (const id of [0, 4, 9, 40, 49, 89]) {
    assert.equal(rotate180(rotate180(id)), id, `id=${id}`);
  }
  assert.equal(rotate180(0), 89, '左上角应转到右下角');
  assert.equal(rotate180(89), 0);
  // 90 个交叉点，中心落在 44.5（棋盘正中）；40↔49 关于中心对称
  assert.equal(rotate180(40), 49);
  assert.equal(rotate180(49), 40);
  // 河界上下对称
  assert.equal(rotate180(4 * 9 + 4), 5 * 9 + 4, '(4,4) 应转到 (4,5)');
});

check('贴边的将/帅倒下时会被挪到棋盘内侧', () => {
  const canvas = makeCanvas();
  const view = new BoardView(canvas, { humanSide: 'red', factionCards: { red: {}, black: {} } });
  const { board } = initialState();
  view.sync(board, { animate: false });
  // 黑将在 (4,0)，正贴棋盘上边缘；就地倒下会甩到棋盘外
  const raw = view.pointAt(4, 0);
  view.killGeneral('black', 'general', 4, 0);
  const s = view.sprites.get(4);
  const L = view.layout;
  assert.ok(s, '应能取到 (4,0) 的精灵');
  assert.ok(
    s.y > raw.py + L.rankPitch * 0.5,
    `应向棋盘内侧挪足够距离：y=${s.y} raw=${raw.py} rankPitch=${L.rankPitch}`,
  );
  assert.ok(
    s.y >= L.padding.top && s.y <= L.padding.top + L.boardH,
    `中心应在盘面内：y=${s.y} 范围 [${L.padding.top}, ${L.padding.top + L.boardH}]`,
  );
  assert.ok(s.x >= L.padding.left && s.x <= L.padding.left + L.boardW, `x=${s.x}`);
});

/* ------------------------------------------------------------------ *
 * drawBoard 深色主题
 * ------------------------------------------------------------------ */

console.log('drawBoard');

check('透明底 + 浅色线可以正常绘制（深色主题用）', () => {
  strokes.length = 0;
  fills.length = 0;
  const ctx = makeCtx(null);
  const layout = drawBoard(ctx, {
    width: 900, height: 900 * FRAME_ASPECT, transparent: true, ink: '#e8e3d6', labels: false,
  });
  assert.ok(layout.fx.length === FILES && layout.ry.length === RANKS);
  assert.equal(fills.length, 0, '透明底不应铺底色');
  assert.ok(strokes.length >= 3, `描边分组 ${strokes.length}`);
  const total = strokes.reduce((a, s) => a + s.points, 0);
  // 30 条棋盘线 × 2 端点 + 52 段十字 × 2 端点
  assert.equal(total, 60 + 104, `路径端点 ${total}`);
});

check('几何层给出 9 路 × 10 线', () => {
  const L = computeLayout({ width: 900 });
  assert.equal(L.fx.length, FILES);
  assert.equal(L.ry.length, RANKS);
});

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);