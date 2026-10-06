/**
 * 棋盘渲染 + 棋子（卡面）渲染，含走子动画与"将死翻倒"动画。
 *
 * 动画都基于时间计算，因此主循环每帧调用 render(now) 即可。
 */
import { drawBoard } from '#shared/board.js';
import {
  FILES,
  FRAME_ASPECT,
  RANKS,
  RIVER_BOTTOM_RANK,
  RIVER_TOP_RANK,
  computeLayout,
  rotate180,
} from '#shared/geometry.js';
import { BACKDROP, BOARD_INSET_MIN, BOARD_INSET_RATIO, CARD_RATIO, CARD_WIDTH_UNITS, DEATH_ROTATION_DEG, ROTATE_OPPONENT_CARDS } from '../theme.js';
import { img, reddened } from '../assets.js';

/** 走子动画时长（毫秒） */
const MOVE_MS = 260;
/** 吃子后残牌留在地上的时长 */
const FALLEN_MS = 1500;

const INK = '#efe9db'; // 深色底上的浅色线条

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export class BoardView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {'red'|'black'} opts.humanSide 玩家执哪一方（决定卡牌朝向）
   * @param {object} opts.factionCards 双方卡面映射 { red: {...}, black: {...} }
   */
  constructor(canvas, { humanSide = 'red', factionCards }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.humanSide = humanSide;
    this.factionCards = factionCards;

    this.layout = null;
    this.cardW = 0;
    this.cardH = 0;

    /** 每帧重算：{ id, type, side, x, y, rot, alpha, scale, red } */
    this.sprites = new Map();
    /** 正在下落的残牌 */
    this.fallen = [];
    /** 高亮 */
    this.selected = null;
    this.targets = new Set();
    this.checkSide = null;
    /**
     * 上一手走法（显示坐标下的格子 id）。
     * 没有它的话，轮到你时得自己在盘上找对方刚把哪个子挪哪去了。
     * { from: number, to: number } | null
     */
    this.lastMove = null;

    /**
     * 顶部 / 底部为浮层预留的像素（HUD 与版权声明）。
     * main.js 在 resize 前设置，避免画布被浮层压住。
     */
    this.reserveTop = 0;
    this.reserveBottom = 0;

    this.resize();
  }

  /**
   * 自适应尺寸。只做**等比缩放**：高度恒等于宽度 × FRAME_ASPECT，
   * 所以棋盘和卡牌在任何窗口下都不会被拉伸。
   *
   * ⚠️ 手机上有三个坑，都必须处理，否则会出现"电脑上好好的、手机上溢出"：
   *   1. 动态视口：地址栏收起/弹出会改变可视高度，但不一定触发 window 的 resize
   *      → 额外监听 visualViewport
   *   2. 旋转屏：orientationchange 触发时布局还没完成，量到的还是旧尺寸
   *      → 延后重算（由 main.js 的 debounce 统一处理）
   *   3. 顶部 HUD 与底部版权声明是浮层，会盖住画布
   *      → 从可用高度里扣掉，而不是只用 innerHeight
   */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // visualViewport 比 innerWidth/innerHeight 更贴近"真正看得见的区域"
    const vv = window.visualViewport;
    const vw = Math.round(vv?.width || window.innerWidth || 1200);
    const vh = Math.round(vv?.height || window.innerHeight || 900);
    const inset = Math.max(BOARD_INSET_MIN, Math.min(vw, vh) * BOARD_INSET_RATIO);

    // 给浮层让位：HUD 在顶部、版权声明在底部，它们是固定定位、会压在画布上
    const reserveTop = this.reserveTop ?? 0;
    const reserveBottom = this.reserveBottom ?? 0;

    const availW = Math.max(120, vw - inset * 2);
    const availH = Math.max(120, vh - reserveTop - reserveBottom - inset * 2);
    // 取能同时放下的最大等比尺寸
    const width = Math.min(availW, availH / FRAME_ASPECT);
    const height = width * FRAME_ASPECT;

    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.layout = computeLayout({ width, height });
    this.cardW = this.layout.filePitch * CARD_WIDTH_UNITS;
    // 整张卡面，不做任何裁剪
    this.cardH = this.cardW * CARD_RATIO;
  }

  /** 交叉点 → 画布像素 */
  pointAt(file, rank) {
    return this.layout.pointAt(file, rank);
  }

  /**
   * 显示空间 ↔ 真实盘面 的索引换算。
   * 执黑时整盘转 180°：真实索引 id 画在显示索引 rotate180(id) 上。
   */
  toDisplay(id) {
    return this.isFlipped() ? rotate180(id) : id;
  }

  fromDisplay(displayId) {
    return this.isFlipped() ? rotate180(displayId) : displayId;
  }

  /**
   * 真实盘面索引 → 画布像素。实时计算，因此始终与翻转状态一致。
   * 如果该位置有精灵且它正在滑动，返回精灵的**当前**位置，
   * 这样高亮框会跟着棋子走，而不是提前跳到终点。
   */
  positionOf(id) {
    const s = this.sprites?.get(id);
    if (s) return { px: s.x, py: s.y };
    const shown = this.toDisplay(id);
    return this.layout.pointAt(shown % FILES, Math.floor(shown / FILES));
  }

  /* ---------------- 棋子精灵 ---------------- */

  /** 执黑时整盘转 180°，让玩家自己的子永远在下方 */
  isFlipped() {
    return this.humanSide === 'black';
  }

  /**
   * 画布像素 → **真实盘面**交叉点，越界返回 null。
   *
   * 翻转时有两套索引，必须分清：
   *   id      = 真实盘面索引（引擎用的，精灵表也按它索引）
   *   display = 屏幕上画的格子 = toDisplay(id)
   * 点击落在 display 格上，要还原成 id，才能查到棋子、才能拿去走子。
   * 所以这里是 toDisplay 的**逆运算**：positionOf(snap(p)) === p。
   */
  snap(px, py) {
    const display = this.displayCellAt(px, py);
    if (!display) return null;
    const id = this.fromDisplay(display.rank * FILES + display.file);
    return { file: id % FILES, rank: Math.floor(id / FILES) };
  }

  /** 画布像素 → 屏幕上的格子（display 空间），越界返回 null */
  displayCellAt(px, py) {
    if (!this.isFlipped()) return this.layout.snap(px, py);
    const { padding, boardW, boardH } = this.layout;
    const mirrored = this.layout.snap(
      2 * padding.left + boardW - px,
      2 * padding.top + boardH - py,
    );
    if (!mirrored) return null;
    return { file: FILES - 1 - mirrored.file, rank: RANKS - 1 - mirrored.rank };
  }

  /** 依据棋局重建精灵列表；已有棋子保留当前位置做平滑移动 */
  sync(board, { animate = true } = {}) {
    const flip = this.isFlipped();
    const seen = new Set();
    for (let id = 0; id < board.length; id++) {
      const p = board[id];
      if (!p) continue;
      seen.add(id);
      // 显示坐标：执黑时把整盘转 180°
      const shown = flip ? rotate180(id) : id;
      const { px, py } = this.layout.pointAt(shown % FILES, Math.floor(shown / FILES));
      // 夹进画布：窄窗口下边缘的牌不能被切掉
      const pos = this.clampToCanvas(px, py, 1);
      const existing = this.sprites.get(id);
      if (existing && animate) {
        existing.tx = pos.x;
        existing.ty = pos.y;
        existing.type = p.type;
        existing.side = p.side;
      } else {
        this.sprites.set(id, {
          id, type: p.type, side: p.side,
          x: pos.x, y: pos.y, tx: pos.x, ty: pos.y,
          born: performance.now(), rot: 0, alpha: 1, scale: 1, red: 0, revealed: false,
        });
      }
    }
    // 被吃掉的棋子：从精灵表移除
    for (const id of [...this.sprites.keys()]) {
      if (!seen.has(id)) this.sprites.delete(id);
    }
    // 画布尺寸可能刚变过（窄窗口），把落点重新夹一遍
    for (const s of this.sprites.values()) {
      const c = this.clampToCanvas(s.tx, s.ty, s.scale ?? 1);
      s.tx = c.x;
      s.ty = c.y;
      if (!animate) {
        s.x = c.x;
        s.y = c.y;
      }
    }
  }

  /**
   * 把「卡面中心」夹进画布，保证整张牌不会被裁。
   *
   * 棋盘四周的留白是按卡面尺寸定的，理论上够用；但窗口很窄时
   * 留白与卡面的比例会变化，加上卡牌还有投影，边缘那几行仍可能探出去。
   * 这里兜底：宁可让边上的牌稍稍离开交叉点，也不让它被画布切掉。
   *
   * 夹的范围按牌**当前朝向**算：竖着的牌只需要半个卡宽/卡高，
   * 只有倒下动画（转起来了）才需要外接圆那么大的余量 —— 否则
   * 正常摆好的边线牌会被无谓地往里推，跟交叉点对不上。
   *
   * @param {number} x 期望的中心 X
   * @param {number} y 期望的中心 Y
   * @param {number} [rot] 牌面当前旋转角（弧度）
   */
  clampToCanvas(x, y, scale = 1, rot = 0) {
    const { layout } = this;
    // 构造期间 sync() 可能先于 resize() 被调用，这时没有 layout，原样返回
    if (!layout || !this.cardW) return { x, y };

    const uprightX = (this.cardW / 2) * scale;
    const uprightY = (this.cardH / 2) * scale;
    const spinX = (Math.hypot(this.cardW, this.cardH) / 2) * scale;

    // 有旋转时按外接圆，没旋转时按半个卡面
    const turning = Math.abs(rot) > 1e-3;
    const halfX = turning ? spinX : uprightX;
    const halfY = turning ? spinX : uprightY;
    const margin = Math.max(1.5, this.cardW * 0.08); // 给投影留一点

    const loX = halfX + margin;
    const loY = halfY + margin;
    return {
      x: Math.min(Math.max(x, loX), Math.max(loX, layout.width - loX)),
      y: Math.min(Math.max(y, loY), Math.max(loY, layout.height - loY)),
    };
  }

  /**
   * 将/帅被将死：原地变红 → 顺时针右转 90° → 倒地（牌面外翻、侧倾、下坠）。
   * 与"被吃掉"的翻倒不同，这里牌还留在原位，方便看清是哪一方的将倒了。
   */
  killGeneral(side, type, id, now) {
    const s = this.sprites.get(id) ?? {
      id, type, side, x: 0, y: 0, tx: 0, ty: 0, born: now,
      rot: 0, alpha: 1, scale: 1, red: 0, revealed: true,
    };
    // 用"显示坐标"判断贴边方向（执黑时整盘是翻转的）
    const flip = this.isFlipped();
    const file = flip ? FILES - 1 - (id % FILES) : id % FILES;
    const rank = flip ? RANKS - 1 - Math.floor(id / FILES) : Math.floor(id / FILES);
    const { px, py } = this.positionOf(id);
    // 将/帅坐在九宫角上（贴棋盘边缘），就地顺时针倒下会甩到棋盘外被裁掉。
    // 往棋盘内侧挪半格，倒下时整张牌都还在盘面里。
    const inwardRank = rank === 0 ? 0.66 : rank === RANKS - 1 ? -0.66 : 0;
    const inwardFile = file === 0 ? 0.5 : file === FILES - 1 ? -0.5 : 0;
    s.x = px + inwardFile * this.layout.filePitch;
    s.y = py + inwardRank * this.layout.rankPitch;
    s.tx = s.x;
    s.ty = s.y;
    s.revealed = true;
    s.killedAt = now;
    s.deathDur = 1500;
    this.sprites.set(id, s);
  }

  /** 每帧推进动画 */
  advance(now) {
    for (const s of this.sprites.values()) {
      const dx = s.tx - s.x;
      const dy = s.ty - s.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        const k = 1 - Math.pow(0.001, 1 / 60); // 与帧率无关的指数逼近
        s.x += dx * k;
        s.y += dy * k;
      } else {
        s.x = s.tx;
        s.y = s.ty;
      }
      // 出场缩放
      const age = now - s.born;
      s.scale = age < 220 ? Math.min(1, 0.7 + 0.3 * easeOut(age / 220)) : 1;
      s.alpha = s.revealed ? 1 : 0;

      // 将死翻倒动画：先变红喘一下，再顺时针 90° 倒地
      if (s.killedAt) {
        const t = Math.min(1, (now - s.killedAt) / (s.deathDur ?? 1500));
        const redEnd = 0.38; // 前 38% 只变红
        const fallT = t <= redEnd ? 0 : (t - redEnd) / (1 - redEnd);
        const e = easeOut(fallT);
        s.red = Math.min(1, t / (redEnd * 0.8));
        s.rot = ((DEATH_ROTATION_DEG * Math.PI) / 180) * e;
        // 转 90° 后卡牌的"长边"变成横向；躺下 = 再绕贴近桌面的一条边翻转，
        // 用 tilt = 1 → CARD_RATIO（配合 paintCard 里的 1/tilt 压缩）实现
        s.tilt = 1 + e * (CARD_RATIO - 1);
        s.alpha = 1;
        s.scale = 1 + 0.1 * e;
      }
    }
    this.fallen = this.fallen.filter((f) => now - f.t0 < FALLEN_MS);
  }

  /** 记录一张被吃掉的牌，之后由 playDeath 播放翻倒动画 */
  addFallen(side, type, px, py) {
    this.fallen.push({ side, type, x: px, y: py, t0: 0, started: false });
  }

  /** 触发某张牌的死亡动画（变红 → 顺时针 90° → 倒地淡出） */
  killAt(px, py, side, type, now) {
    this.fallen.push({ side, type, x: px, y: py, t0: now, started: true });
  }

  /* ---------------- 绘制 ---------------- */

  /**
   * @param {number} now performance.now()
   */
  render(now) {
    const { ctx, layout } = this;
    this.advance(now);

    // 背景：铺满整幅，保持比例居中裁切。
    // 亮度已在构建阶段调好；这里只用 drawImage + fillRect，
    // 不用 ctx.filter（实测它会把这次 drawImage 合成成黑色）。
    ctx.save();
    ctx.clearRect(0, 0, layout.width, layout.height);
    const bg = img('assets/background.webp');
    const scale = Math.max(layout.width / bg.width, layout.height / bg.height);
    const bw = bg.width * scale;
    const bh = bg.height * scale;
    ctx.drawImage(bg, (layout.width - bw) / 2, (layout.height - bh) / 2, bw, bh);
    ctx.fillStyle = `rgba(${BACKDROP.scrimColor}, ${BACKDROP.scrimAlpha})`;
    ctx.fillRect(0, 0, layout.width, layout.height);
    ctx.restore();

    // 网格（透明底 + 浅色线）
    drawBoard(ctx, {
      width: layout.width,
      height: layout.height,
      transparent: true,
      ink: INK,
      labels: false, // 河界文字单独画在下面，用深色底上的样式
    });

    this.drawRiverText();
    this.drawHighlights(now);
    this.drawFallen(now);
    this.drawSprites(now);
  }

  drawRiverText() {
    const { ctx, layout } = this;
    const riverTop = layout.ry[RIVER_TOP_RANK];
    const riverBottom = layout.ry[RIVER_BOTTOM_RANK];
    const riverH = riverBottom - riverTop;
    const cy = (riverTop + riverBottom) / 2;

    // 字号必须保证"字高 + 上下留白"塞得进河界带，否则横屏时会溢出去压住棋子。
    // 河道文字是**背景质感**，不是主角：压小、压淡，别跟棋子抢视线。
    const fontSize = Math.min(layout.rankPitch * 0.5, riverH * 0.56);

    // 河界带内的暗色底，让文字更清楚（同样压淡）
    ctx.save();
    ctx.fillStyle = 'rgba(8, 12, 16, 0.26)';
    ctx.fillRect(layout.boardLeft, riverTop, layout.boardW, riverH);
    ctx.restore();

    this._riverText = { fontSize, cy, riverTop, riverBottom };
  }

  /**
   * 河界文字（柏林 / 莫斯科）。
   * 在棋子**之前**绘制：它是河道上的印字，棋子压在上面才对，
   * 反过来会让"莫"字盖住正好走到河界的牌。
   */
  drawRiverTextOverlay() {
    const { ctx, layout } = this;
    if (!this._riverText) return;
    const { fontSize, cy, riverTop, riverBottom } = this._riverText;
    const step = fontSize * 1.12;
    const offset = layout.filePitch * 1.3;

    ctx.save();
    // 死锁在河界带内：任何情况下都不会画到棋子上去
    ctx.beginPath();
    ctx.rect(layout.boardLeft, riverTop, layout.boardW, riverBottom - riverTop);
    ctx.clip();

    ctx.globalAlpha = 0.45; // 背景质感，不抢戏
    ctx.fillStyle = '#f4eee0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${fontSize}px "Noto Serif SC","Songti SC","SimSun",serif`;
    const mid = (layout.boardLeft + layout.boardRight) / 2;
    const draw = (text, cx) => {
      const chars = [...text];
      const total = step * (chars.length - 1);
      let x = cx - total / 2;
      for (const ch of chars) {
        ctx.fillText(ch, x, cy);
        x += step;
      }
    };
    draw('柏林', mid - offset);
    draw('莫斯科', mid + offset);
    ctx.restore();
  }

  /**
   * 标记"上一手"：起点虚线框、终点实线框。
   * 传入的是**模型坐标**的格子 id，这里转成显示坐标（执黑时整盘翻转）。
   * @param {number|null} from 起点（模型 id）
   * @param {number|null} to 终点（模型 id）
   * @param {number} [now] 时间戳，用于起点框淡出
   */
  markLastMove(from, to, now = performance.now()) {
    if (from == null || to == null) {
      this.lastMove = null;
      return;
    }
    const flip = this.isFlipped();
    this.lastMove = {
      from: flip ? rotate180(from) : from,
      to: flip ? rotate180(to) : to,
      t: now,
    };
  }

  /**
   * 画"上一手"标记。
   *
   * 视觉权重刻意压低：棋盘上随时有 32 张花卡，标记只是辅助，
   * 抢眼反而看不清棋。所以
   *   - 都画在选中框**之前**（会被选中框盖住，不干扰操作）
   *   - 终点的实心框只保留形状，跟"流动虚线"的选中框区分
   *   - 起点的虚框几秒后淡出，避免整盘长期挂着一堆框
   */
  drawLastMove(now) {
    const lm = this.lastMove;
    if (!lm) return;
    const { ctx, layout } = this;
    const r = layout.filePitch * 0.5;
    const age = now - (lm.t ?? now);

    // 起点：虚线框，6 秒内淡出（"这个子是从这儿来的"是一眼的事）
    const fromAlpha = Math.max(0, Math.min(1, 1 - age / 6000));
    if (fromAlpha > 0.02) {
      const a = this.positionOf(lm.from);
      ctx.save();
      ctx.strokeStyle = `rgba(140, 205, 255, ${0.8 * fromAlpha})`;
      ctx.lineWidth = Math.max(1.5, layout.filePitch * 0.032);
      ctx.setLineDash([layout.filePitch * 0.14, layout.filePitch * 0.12]);
      ctx.strokeRect(a.px - r, a.py - r, r * 2, r * 2);
      ctx.restore();
    }

    // 终点：细实线框 + 四角短标记（"它落在这儿"，一直留着直到下一手）
    const b = this.positionOf(lm.to);
    const pulse = 0.8 + 0.2 * Math.sin(now / 340);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 186, 74, ${0.7 * pulse})`;
    ctx.lineWidth = Math.max(1.5, layout.filePitch * 0.03);
    ctx.strokeRect(b.px - r, b.py - r, r * 2, r * 2);

    const arm = r * 0.42;
    ctx.lineWidth = Math.max(2.5, layout.filePitch * 0.055);
    ctx.strokeStyle = `rgba(255, 214, 130, ${0.95 * pulse})`;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = b.px + sx * r;
      const cy = b.py + sy * r;
      ctx.moveTo(cx - sx * arm, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy - sy * arm);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawHighlights(now) {
    const { ctx, layout } = this;

    // 上一手（画在最底层，不抢选中态）
    this.drawLastMove(now);

    // 可走点
    if (this.targets.size) {
      ctx.save();
      const pulse = 0.72 + 0.28 * Math.sin(now / 260);
      for (const id of this.targets) {
        const { px, py } = this.positionOf(id);
        const occupied = [...this.sprites.values()].some((s) => Math.abs(s.tx - px) < 1 && Math.abs(s.ty - py) < 1);
        ctx.beginPath();
        if (occupied) {
          ctx.strokeStyle = `rgba(255, 196, 92, ${0.85 * pulse})`;
          ctx.lineWidth = Math.max(2, layout.filePitch * 0.045);
          ctx.arc(px, py, layout.filePitch * 0.42, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(255, 214, 130, ${0.5 * pulse})`;
          ctx.arc(px, py, layout.filePitch * 0.12, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // 选中框
    if (this.selected != null) {
      const { px, py } = this.positionOf(this.selected);
      ctx.save();
      const r = layout.filePitch * 0.56;
      ctx.strokeStyle = 'rgba(255, 214, 130, 0.95)';
      ctx.lineWidth = Math.max(2, layout.filePitch * 0.035);
      ctx.setLineDash([layout.filePitch * 0.14, layout.filePitch * 0.1]);
      ctx.lineDashOffset = -(now / 45) % 1000;
      ctx.strokeRect(px - r, py - r * 1.1, r * 2, r * 2.2);
      ctx.restore();
    }

    // 被将军的将/帅：红圈闪烁
    if (this.checkSide != null) {
      const g = this.sprites.get(this._generalId?.[this.checkSide]);
      if (g) {
        ctx.save();
        ctx.strokeStyle = `rgba(255, 72, 60, ${0.5 + 0.5 * Math.sin(now / 180)})`;
        ctx.lineWidth = Math.max(3, layout.filePitch * 0.06);
        ctx.beginPath();
        ctx.arc(g.x, g.y, layout.filePitch * 0.62, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /** 被吃掉的牌：红色 → 顺时针右转 90° → 倒地淡出 */
  drawFallen(now) {
    for (const f of this.fallen) {
      if (!f.started) {
        f.started = true;
        f.t0 = now;
      }
      const t = Math.min(1, (now - f.t0) / 900);
      const e = easeOut(t);
      const rot = (DEATH_ROTATION_DEG * Math.PI / 180) * e;
      const alpha = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
      const red = Math.min(1, t / 0.3);
      const scale = 1 + 0.06 * e;
      // 躺下 = 绕贴近桌面的那条边翻转：先转 90°（spin），再压扁（tilt）
      this.paintCard(f.side, f.type, f.x, f.y, {
        rot: 0, alpha, red, scale, spin: 1 - e, tilt: 1 + e * (CARD_RATIO - 1),
      });
      void rot;
    }
  }

  /**
   * 绘制顺序（后画的盖在上面）：
   *   1. 离视线远的一侧
   *   2. y 小的先画 —— 这样每张牌的"名称栏"都在下方那一张的后面，
   *      被压住的是插画而不是牌名
   *   3. 选中的、以及正在倒下的将，永远画在最上面
   */
  drawSprites(now) {
    for (const s of this.sprites.values()) {
      if (s.revealed) continue;
      const delay = s.side === this.humanSide ? 0 : 280;
      if (now - s.born >= delay) s.revealed = true;
    }

    const rankOf = (s) => (s.killedAt ? 2 : s.id === this.selected ? 1 : 0);
    const order = [...this.sprites.values()].sort((a, b) => {
      const ra = rankOf(a);
      const rb = rankOf(b);
      if (ra !== rb) return ra - rb; // 高优先级后画
      return b.y - a.y; // y 大的先画，y 小的后画（名称栏不被压）
    });

    for (const s of order) {
      if (!s.revealed) continue;
      this.paintCard(s.side, s.type, s.x, s.y, {
        rot: s.rot,
        alpha: s.alpha,
        red: s.red,
        scale: s.scale,
        spin: s.spin ?? 1,
        tilt: s.tilt ?? 1,
      });
    }
  }

  /** 画一张完整卡面（不裁剪，名称栏与数值栏都在） */
  paintCard(side, type, cx, cy, { rot = 0, alpha = 1, red = 0, scale = 1, tilt = 1, spin = 1 } = {}) {
    const cards = this.factionCards[side];
    const url = cards?.[type];
    if (!url) return;
    const image = red > 0.5 ? reddened(url) : img(url);

    const { ctx } = this;
    const w = this.cardW * scale;
    const h = this.cardH * scale;
    // 默认不转：卡面上有单位名与数值，转过去对玩家就是倒着的字。
    // 想要象棋"双方各自朝向本方"的传统观感，把 ROTATE_OPPONENT_CARDS 打开。
    const facing = ROTATE_OPPONENT_CARDS && side !== this.humanSide ? Math.PI : 0;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(cx, cy);
    ctx.rotate(facing + rot);
    // spin：整张牌绕自己的中心转（被吃掉的残牌用），
    // 和 tilt 一起作用才能做出"牌躺下"的形状而不是一根细条
    if (spin < 1) ctx.scale(Math.max(0.12, spin), 1);
    // tilt > 1：绕贴近桌面的那条边翻转（立着 → 躺平）
    if (tilt > 1.001) ctx.scale(1, Math.max(0.12, 1 / tilt));
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = this.cardW * 0.1;
    ctx.shadowOffsetY = this.cardH * 0.04;
    ctx.drawImage(image, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /** 触发死亡动画：在指定棋盘索引上放一张翻倒的牌 */
  playDeath(side, type, id, now) {
    const { px, py } = this.positionOf(id);
    this.killAt(px, py, side, type, now);
  }
}
