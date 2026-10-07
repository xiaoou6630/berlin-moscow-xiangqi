/**
 * 标准中国象棋棋盘几何
 *
 * 依据《中国象棋竞赛规则》(国家体育总局审定) 第 1 条：
 *   「象棋盘由九道直线和十道横线交叉组成。棋盘上共有九十个交叉点，
 *     象棋子就摆在和活动在这些交叉点上。棋盘中间没有划通直线的地方，
 *     叫做"河界"；划有斜交叉线的地方，叫做"九宫"。」
 *   「比赛用的标准棋盘，应每格都为正方形，每方格长宽均应为 3.2 至 4.6cm。」
 *
 * 因此：
 *   - 直线（纵线）10 条 → 9 路（file）
 *   - 横线 11 条        → 10 线（rank）
 *   - 90 个交叉点，棋子落在交叉点上（不是格子中心）
 *   - 河界位于第 5、6 线之间；河界内只有最左最右两条直线贯通
 *   - 上下各一个九宫：3×3 交叉点，画两条对角斜线（"米字格"）
 *
 * 坐标约定：一律使用「交叉点坐标」(file, rank)
 *   file: 0..8   从红方视角自右向左为 1..9 路；这里 0 = 最左
 *   rank: 0..9   0 = 最上（黑方底线），9 = 最下（红方底线）
 * 视角：下方为红方（柏林），上方为黑方（莫斯科）
 */

/* ------------------------------------------------------------------ *
 * 规格常量（单位 = 一个"格"的宽度；1 unit = 相邻两路的间距）
 * ------------------------------------------------------------------ */

export const FILES = 9; // 九道直线 → 9 路
export const RANKS = 10; // 十道横线 → 10 线

/** 相邻两路的间距（单位） */
export const FILE_GAP = 1;

/**
 * 相邻两线的间距（单位）。
 * 规则要求每格正方形 → 1，此时整幅为 8:9 的竖式棋盘。
 * 设为 1.125 则贴近参考图实测比例（格宽 147px / 格高 130px）。
 */
export const RANK_GAP = 1;

/**
 * 卡面尺寸（单位）—— 与 public/src/theme.js 共用同一来源。
 *
 * ⚠️ 这里是**几何的输入**：棋盘四周留白与整幅比例都由它推导，
 * 所以绝不能在别处再写一份（真的踩过：geometry 用 0.65 反推留白，
 * 而 theme 仍按 0.86 画牌，最外两行的牌照样伸出画布）。
 *
 * 取 0.9（比原来的 0.6 大 1.5 倍）：
 *   - 横向安全：卡宽 0.9 < 相邻路间距 1，左右**不会**重叠；
 *     留白 MARGIN_X=0.62 > 0.9/2=0.45，最外一路的牌伸不出棋盘。
 *   - 纵向会叠：卡高 1.264 > 相邻线间距 1，上下相邻的两个子重叠约 0.26 格
 *     （宽屏约 19px）。这是**放大卡面的必然代价**，因为卡面比例固定、
 *     绝不能裁剪。绘制顺序按 y 排序（靠下的画在上面），观感与卡牌游戏
 *     "后排压前排"一致；点选用 snap 吸附到最近的交叉点，越界区域不会误选。
 *   - 留白 MARGIN_Y 由卡高推导，会自动跟着变大，保证顶/底行的牌不伸出去。
 */
export const CARD_WIDTH_UNITS = 0.9;
export const CARD_ASPECT = 702 / 500;
export const CARD_HEIGHT_UNITS = CARD_WIDTH_UNITS * CARD_ASPECT;
/** 牌绕中心旋转时的外接圆半径（倒下动画用得到） */
export const CARD_SPIN_RADIUS = Math.hypot(CARD_WIDTH_UNITS, CARD_HEIGHT_UNITS) / 2;

/**
 * 棋盘四周留白（单位）——**由卡面尺寸推导**，不手工调。
 *
 * 牌以交叉点为中心摆放，会向外伸出半个卡宽 / 半个卡高，所以：
 *   纵向 MARGIN_Y ≥ 卡高/2      （上下各伸半张，一整张卡要放得下两倍留白）
 *   横向 MARGIN_X ≥ 卡宽/2
 * 这里各留一点余量给投影。
 *
 * 横向值同时决定整幅比例：
 *   FRAME_ASPECT = (9 + 2·MARGIN_Y) / (8 + 2·MARGIN_X)
 * 取 0.62 让整幅保持竖式（比例 ≈ 1.09），观感与之前一致。
 */
export const MARGIN_Y = CARD_HEIGHT_UNITS / 2 + 0.06;
export const MARGIN_X = 0.62;
export const MARGIN = MARGIN_X; // 兼容旧引用

/** 河界所在的两条横线序号（0 起）：第 5 线(4) 与 第 6 线(5) 之间 */
export const RIVER_TOP_RANK = 4;
export const RIVER_BOTTOM_RANK = 5;

/** 九宫：上（黑方）与下（红方），以 3×3 交叉点的左上角定位 */
export const PALACES = [
  { file: 3, rank: 0, size: 2 }, // 上方九宫：3..5 路 / 0..2 线
  { file: 3, rank: 7, size: 2 }, // 下方九宫：3..5 路 / 7..9 线
];

/**
 * "十"字定位标记。
 * 标准象棋盘在双方炮位与兵（卒）位上画小十字，便于辨认落点：
 *   炮位：第 2、8 路 的 第 2、7 线
 *   兵位：第 1、3、5、7、9 路 的 第 3、6 线
 * 形制：以交叉点为中心，四向四小段；中心留空，线条不穿过交点；
 *       靠棋盘边缘的一侧裁掉，避免出框。
 */
export const CROSS_MARKS = (() => {
  const out = [];
  for (const rank of [2, 7]) {
    for (const file of [1, 7]) out.push({ file, rank });
  }
  for (const rank of [3, 6]) {
    for (const file of [0, 2, 4, 6, 8]) out.push({ file, rank });
  }
  return out;
})();

/** 十字标记形制（单位：路距） */
export const CROSS_STYLE = {
  /** 外边距 / 线距 —— 从交叉点向外延伸 */
  outer: 0.34,
  /** 内边距 / 线距 —— 交点附近留空 */
  inner: 0.07,
  /** 线粗 / 路距（明显粗于棋盘线，便于辨认；与常见棋盘一致） */
  weight: 0.034,
};

/** 河界文字（沿用参考图：柏林 / 莫斯科） */
export const RIVER_LABELS = {
  left: '柏林',
  right: '莫斯科',
  /** 字号 / 线距 */
  fontScale: 0.62,
  /** 组内字距 / 字号 */
  letterSpacing: 0.22,
  /** 每组文字中心相对棋盘中轴的偏移 / 路距 */
  offsetFiles: 1.35,
};

/** 线条样式：底色浅、线为深色，符合规则「底色均应为白色或浅色」 */
export const LINE_STYLE = {
  /** 线宽 / 路距 */
  widthRatio: 0.021,
  minWidth: 1,
  maxWidth: 5,
  color: '#1c1c1c',
  paper: '#fdfdfb',
};

/** 棋盘外框相对普通线宽的比例（外边框通常略粗，但此处保持一致，如参考图） */
export const BORDER_WIDTH_RATIO = 1;

/* ------------------------------------------------------------------ *
 * 布局计算
 * ------------------------------------------------------------------ */

const BOARD_UNITS_W = (FILES - 1) * FILE_GAP; // 8
const BOARD_UNITS_H = (RANKS - 1) * RANK_GAP; // 9
const FRAME_UNITS_W = BOARD_UNITS_W + MARGIN_X * 2;
const FRAME_UNITS_H = BOARD_UNITS_H + MARGIN_Y * 2;

/** 整幅（含留白）宽高比 */
export const FRAME_ASPECT = FRAME_UNITS_H / FRAME_UNITS_W;

/** 参考图实测（仅作对照用）：路距 147.1px，线距 130.3px */
export const REFERENCE_MEASURED = {
  filePitch: 147.1,
  rankPitch: 130.3,
  get ratio() {
    return this.rankPitch / this.filePitch; // ≈ 0.886
  },
};

/**
 * 计算像素布局。所有比例相对整幅宽度缩放，任意尺寸下格子的
 * 宽高比、留白比例都与规格一致。
 *
 * ⚠️ **width/height 是"可用空间的边界框"，不是目标尺寸**：
 *    整幅按自身宽高比等比缩放到**刚好放得进**这个框，两者都不得超出。
 *    曾经这里只按 width 缩放、把 height 当输出（只用来反算），
 *    在整幅比例 1.078（接近 8:9）时侥幸没露馅；
 *    一旦比例变宽（卡面放大后留白变高），棋盘就会**高出画布一倍**
 *    —— 顶/底行的牌直接跑出视口。现在按两个方向分别算、取小的那个。
 *
 * @param {object} [opts]
 * @param {number} [opts.width]  可用宽度（CSS 像素）
 * @param {number} [opts.height] 可用高度（CSS 像素）
 */
export function computeLayout(opts = {}) {
  const { width: boxW, height: boxH } = opts;

  if (boxW == null && boxH == null) {
    // 都没给：用参考尺寸
    const unit0 = 1182 / FRAME_UNITS_W;
    return layoutWithUnit(1182, 1182 * FRAME_ASPECT, unit0);
  }

  // 只给一边：另一边由整幅比例推出（此时就是"目标尺寸"，不会超出）
  if (boxW == null) {
    const w = boxH / FRAME_ASPECT;
    return layoutWithUnit(w, boxH, w / FRAME_UNITS_W);
  }
  if (boxH == null) {
    const h = boxW * FRAME_ASPECT;
    return layoutWithUnit(boxW, h, boxW / FRAME_UNITS_W);
  }

  // 两边都给：按两个方向分别算 unit，取小的，保证整幅**放得进**边界框
  const unit = Math.min(boxW / FRAME_UNITS_W, boxH / FRAME_UNITS_H);
  return layoutWithUnit(FRAME_UNITS_W * unit, FRAME_UNITS_H * unit, unit);
}

/** 用给定的 unit 生成布局（整幅尺寸由 unit 推出） */
function layoutWithUnit(width, height, unit) {
  const padX = MARGIN_X * unit;
  const padY = MARGIN_Y * unit;

  const filePitch = FILE_GAP * unit;
  const rankPitch = RANK_GAP * unit;

  const boardW = BOARD_UNITS_W * unit;
  const boardH = BOARD_UNITS_H * unit;

  /** 第 f 条直线的 x */
  const fx = Array.from({ length: FILES }, (_, f) => padX + f * filePitch);
  /** 第 r 条横线的 y */
  const ry = Array.from({ length: RANKS }, (_, r) => padY + r * rankPitch);

  const lineWidth = clamp(LINE_STYLE.widthRatio * filePitch, LINE_STYLE.minWidth, LINE_STYLE.maxWidth);

  return {
    width,
    height,
    unit,
    fx,
    ry,
    filePitch,
    rankPitch,
    boardW,
    boardH,
    boardLeft: fx[0],
    boardTop: ry[0],
    boardRight: fx[FILES - 1],
    boardBottom: ry[RANKS - 1],
    padding: { left: padX, right: padX, top: padY, bottom: padY },
    lineWidth,
    borderWidth: lineWidth * BORDER_WIDTH_RATIO,
    /** 交叉点坐标 → 画布像素 */
    pointAt(file, rank) {
      return { px: padX + file * filePitch, py: padY + rank * rankPitch };
    },
    /** 画布像素 → 交叉点坐标（可为小数） */
    pointFrom(px, py) {
      return { file: (px - padX) / filePitch, rank: (py - padY) / rankPitch };
    },
    /** 圆整到最近的交叉点 */
    snap(px, py) {
      const p = { file: Math.round((px - padX) / filePitch), rank: Math.round((py - padY) / rankPitch) };
      return p.file >= 0 && p.file < FILES && p.rank >= 0 && p.rank < RANKS ? p : null;
    },
  };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* ------------------------------------------------------------------ *
 * 线段
 * ------------------------------------------------------------------ */

/**
 * 生成全部线段。
 * kind: 'border' 外框 | 'line' 普通直线/横线 | 'riverText' 说明用 | 'diagonal' 九宫斜线
 */
export function buildSegments(layout) {
  const { fx, ry, lineWidth } = layout;
  const segs = [];
  const L = fx[0];
  const R = fx[FILES - 1];
  const T = ry[0];
  const B = ry[RANKS - 1];

  // 10 道横线：整幅贯通
  for (let r = 0; r < RANKS; r++) {
    segs.push({ x1: L, y1: ry[r], x2: R, y2: ry[r], kind: 'line' });
  }

  // 河界上下边界（第 4、5 线）就是上面已加的横线，无需重复

  // 10 道直线：
  //   最左(0)、最右(FILES-1) 两条贯通全盘；
  //   其余在河界处断开。
  const riverTop = ry[RIVER_TOP_RANK];
  const riverBottom = ry[RIVER_BOTTOM_RANK];
  for (let f = 0; f < FILES; f++) {
    if (f === 0 || f === FILES - 1) {
      segs.push({ x1: fx[f], y1: T, x2: fx[f], y2: B, kind: 'border' });
    } else {
      segs.push({ x1: fx[f], y1: T, x2: fx[f], y2: riverTop, kind: 'line' });
      segs.push({ x1: fx[f], y1: riverBottom, x2: fx[f], y2: B, kind: 'line' });
    }
  }

  // 上下九宫各两条斜线
  for (const p of PALACES) {
    const a = { x: fx[p.file], y: ry[p.rank] };
    const b = { x: fx[p.file + p.size], y: ry[p.rank + p.size] };
    segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, kind: 'diagonal' });
    segs.push({ x1: b.x, y1: a.y, x2: a.x, y2: b.y, kind: 'diagonal' });
  }

  void lineWidth;
  return segs;
}

/** 河界矩形 */
export function buildRiver(layout) {
  const top = layout.ry[RIVER_TOP_RANK];
  const bottom = layout.ry[RIVER_BOTTOM_RANK];
  return {
    x: layout.boardLeft,
    y: top,
    width: layout.boardW,
    height: bottom - top,
    centerX: (layout.boardLeft + layout.boardRight) / 2,
    centerY: (top + bottom) / 2,
  };
}

/**
 * "十"字标记的四小段（每个标记 4 段，中心留空、贴边裁切）。
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number,file:number,rank:number}>}
 */
export function buildCrossSegments(layout) {
  const { filePitch, rankPitch } = layout;
  const inner = CROSS_STYLE.inner;
  const outer = CROSS_STYLE.outer;
  const segs = [];

  for (const m of CROSS_MARKS) {
    const { px, py } = layout.pointAt(m.file, m.rank);
    const left = px - inner * filePitch;
    const right = px + inner * filePitch;
    const up = py - inner * rankPitch;
    const down = py + inner * rankPitch;

    // 左臂（会伸出棋盘外则省略）
    if (px - outer * filePitch >= layout.boardLeft - 1e-9) {
      segs.push({ x1: px - outer * filePitch, y1: py, x2: left, y2: py, file: m.file, rank: m.rank });
    }
    // 右臂
    if (px + outer * filePitch <= layout.boardRight + 1e-9) {
      segs.push({ x1: right, y1: py, x2: px + outer * filePitch, y2: py, file: m.file, rank: m.rank });
    }
    // 上臂
    if (py - outer * rankPitch >= layout.boardTop - 1e-9) {
      segs.push({ x1: px, y1: py - outer * rankPitch, x2: px, y2: up, file: m.file, rank: m.rank });
    }
    // 下臂
    if (py + outer * rankPitch <= layout.boardBottom + 1e-9) {
      segs.push({ x1: px, y1: down, x2: px, y2: py + outer * rankPitch, file: m.file, rank: m.rank });
    }
  }
  return segs;
}

/** 全部交叉点 [file, rank] */
export function allPoints() {
  const out = [];
  for (let f = 0; f < FILES; f++) {
    for (let r = 0; r < RANKS; r++) out.push({ file: f, rank: r });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 视角翻转
 * ------------------------------------------------------------------ */

/** 棋盘 180° 旋转的轴（90 个点，中心在索引 40） */
export const PIVOT = (FILES * RANKS - 1) / 2;

/**
 * 索引 → 180° 旋转后的索引。
 * 用于把"执黑"的玩家也放到屏幕下方：黑方看到的画面是真实棋盘转 180°，
 * 这样自己的子永远在近端（象棋里黑方把棋盘转过来看是常规做法）。
 */
export const rotate180 = (id) => 2 * PIVOT - id;

export { clamp };
