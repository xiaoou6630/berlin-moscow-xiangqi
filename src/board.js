/**
 * 棋盘绘制器：把 geometry 定义的标准象棋盘画到 2D canvas 上。
 * 纯函数式，不依赖 DOM 结构，浏览器与 Node 截图工具都能复用。
 */
import {
  CROSS_STYLE,
  FILES,
  LINE_STYLE,
  RIVER_LABELS,
  buildCrossSegments,
  buildRiver,
  buildSegments,
  computeLayout,
} from './geometry.js';

const FONT_STACK =
  '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", "STSong", "Microsoft YaHei", serif';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} [options]
 * @param {number} [options.width]   整幅宽度（CSS 像素）
 * @param {number} [options.height]  整幅高度（CSS 像素）
 * @param {string} [options.paper]   底色（规则要求白色/浅色）
 * @param {string} [options.ink]     线条颜色
 * @param {boolean}[options.transparent] 透明底
 * @param {boolean}[options.labels]  是否绘制河界文字（默认 true）
 * @param {boolean}[options.marks]   是否绘制炮位/兵位十字（默认 true）
 * @returns {ReturnType<typeof computeLayout>} 本次绘制使用的布局
 */
export function drawBoard(ctx, options = {}) {
  const {
    width,
    height,
    paper = LINE_STYLE.paper,
    ink = LINE_STYLE.color,
    transparent = false,
    labels = true,
    marks = true,
  } = options;

  const layout = computeLayout({ width, height });

  ctx.save();

  // ⚠️ 这里**不能**无条件 clearRect：
  // caller 往往先把背景底图画好再调 drawBoard(transparent:true)，
  // 清屏会把底图整幅擦掉（曾经因此让背景完全不可见）。
  // 需要清屏时由 caller 自己负责。
  if (!transparent) {
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, layout.width, layout.height);
  }

  ctx.strokeStyle = ink;
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';

  const segments = buildSegments(layout);
  const byKind = new Map();
  for (const s of segments) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, []);
    byKind.get(s.kind).push(s);
  }

  for (const [kind, list] of byKind) {
    ctx.lineWidth = kind === 'border' ? layout.borderWidth : layout.lineWidth;
    ctx.beginPath();
    for (const s of list) {
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
    }
    ctx.stroke();
  }

  if (marks) drawCrossMarks(ctx, layout, ink);

  if (labels) drawRiverLabels(ctx, layout, ink);

  ctx.restore();
  return layout;
}

/**
 * 炮位 / 兵位的"十"字标记。
 * 每段单独描边，保证端头方正；中心留空由 geometry 控制。
 */
function drawCrossMarks(ctx, layout, ink) {
  const segs = buildCrossSegments(layout);
  if (!segs.length) return;

  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(layout.lineWidth, CROSS_STYLE.weight * layout.filePitch);
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const s of segs) {
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
  }
  ctx.stroke();
  ctx.restore();
}

/** 绘制河界文字（柏林 / 莫斯科） */
function drawRiverLabels(ctx, layout, ink) {
  const river = buildRiver(layout);
  const fontSize = layout.rankPitch * RIVER_LABELS.fontScale;
  const step = fontSize * (1 + RIVER_LABELS.letterSpacing);
  const offset = layout.filePitch * RIVER_LABELS.offsetFiles;

  ctx.save();
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${fontSize}px ${FONT_STACK}`;

  drawSpacedText(ctx, RIVER_LABELS.left, river.centerX - offset, river.centerY, step);
  drawSpacedText(ctx, RIVER_LABELS.right, river.centerX + offset, river.centerY, step);

  ctx.restore();
}

/** 逐字居中排布，字距可控（不依赖 ctx.letterSpacing） */
function drawSpacedText(ctx, text, centerX, centerY, step) {
  const chars = [...text];
  const total = step * (chars.length - 1);
  let x = centerX - total / 2;
  for (const ch of chars) {
    ctx.fillText(ch, x, centerY);
    x += step;
  }
}

export { FILES };
