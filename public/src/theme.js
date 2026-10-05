/**
 * 主题数据：阵营、棋子 → 卡面映射、初始布局。
 *
 * 素材由 tools/build-assets.py 从 苏联/ 与 德国/ 生成到 public/assets/。
 * 苏联（红方）在下；德国（黑方）在上。
 *
 * 注意：苏联给的素材里没有"相/象"这一路，暂时用"战术撤退"顶替（见 soviet.elephant）。
 *       德军与苏军的全部 7 种棋子都需要有图，否则该子无法显示。
 */

export const SOVIET = 'soviet';
export const GERMANY = 'germany';

export const FACTIONS = {
  [SOVIET]: {
    id: SOVIET,
    name: '莫斯科',
    subtitle: '苏联 · 红军',
    portrait: 'portraits/soviet.png',
    /** 棋盘上该阵营的棋子落在下方（红方） */
    side: 'red',
    accent: '#d8342a',
    cards: {
      general: 'cards/soviet/general.png',
      advisor: 'cards/soviet/advisor.png', // 近卫步兵第 272 团
      elephant: 'cards/soviet/elephant.png', // 战术撤退
      horse: 'cards/soviet/horse.png',
      chariot: 'cards/soviet/chariot.png',
      cannon: 'cards/soviet/cannon.png',
      pawn: 'cards/soviet/pawn.png',
    },
  },
  [GERMANY]: {
    id: GERMANY,
    name: '柏林',
    subtitle: '德国 · 国防军',
    portrait: 'portraits/germany.png',
    side: 'black',
    accent: '#8a7b52',
    cards: {
      general: 'cards/germany/general.png',
      advisor: 'cards/germany/advisor.png',
      elephant: 'cards/germany/elephant.png',
      horse: 'cards/germany/horse.png',
      chariot: 'cards/germany/chariot.png',
      cannon: 'cards/germany/cannon.png',
      pawn: 'cards/germany/pawn.png',
    },
  },
};

/** 卡面原始比例（500 × 702） */
export const CARD_RATIO = 702 / 500;

/**
 * 卡面不做任何裁剪，整张显示（名称栏、数值栏都在）。
 * 牌高 = 牌宽 × 1.404。牌宽取 0.86 格 → 牌高 ≈ 1.21 格，
 * 相邻两线约重叠 1/5，名称与数值都清楚，插画也还认得出。
 */
export const CARD_WIDTH_UNITS = 0.86;

/**
 * 棋盘四周留白：占较短边的比例。整体收一点，不要顶满屏幕。
 */
export const BOARD_INSET_RATIO = 0.05;
export const BOARD_INSET_MIN = 14;

/**
 * 背景处理。
 *
 * 亮度全部在构建阶段（tools/build-assets.py）调好，绘制时**不碰 ctx.filter**：
 * 实测 `ctx.filter = 'brightness(...)'` 在部分环境下会让这次 drawImage 的结果
 * 被合成成纯黑（底图等于没画），所以这里保持 gain=1。
 */
export const BACKDROP = {
  /** 背景按原图直出，不做任何亮度调整；只压极薄一层保证网格可读 */
  scrimAlpha: 0.08,
  scrimColor: '18, 24, 32',
  /** 棋盘内空白处至少要有的纹理方差（太扁平说明底图被压没了） */
  minTextureStd: 4,
};

/**
 * 是否把**对手**的卡面转 180°。
 *
 * 象棋惯例是"双方的子各自朝向本方"，但卡面上有单位名和数值，
 * 转过去对玩家就是一片倒着的字，很容易被当成渲染坏了。
 * 默认 false：所有卡面一律正着显示，谁看都读得懂。
 * 想要传统朝向就改成 true。
 */
export const ROTATE_OPPONENT_CARDS = false;

/** 被将死时卡牌翻倒的方向：顺时针 90° */
export const DEATH_ROTATION_DEG = 90;

/** 将死翻倒动画总时长（毫秒），结算面板等它播完再弹 */
export const DEATH_MS = 1100;

/** 档位（与 src/engine/ai.js 的 LEVELS 对应，这里只放界面用的名称） */
export const DIFFICULTY_UI = [
  { id: 1, name: '新兵', desc: '看两步，会走漏着' },
  { id: 2, name: '老兵', desc: '看三步，稳扎稳打' },
  { id: 3, name: '军官', desc: '看四步，会算交换' },
  { id: 4, name: '元帅', desc: '看五步，绝不手软' },
];

export const sideOfFaction = (factionId) => FACTIONS[factionId]?.side ?? 'red';
export const factionOfSide = (side) => (side === 'red' ? SOVIET : GERMANY);
