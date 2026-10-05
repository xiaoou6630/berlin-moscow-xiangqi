/**
 * 几何回归测试：验证标准象棋盘规格（9 路 × 10 线 / 90 交叉点 / 河界 / 九宫）
 * 在任意缩放下都成立。
 * 运行：npm test
 */
import assert from 'node:assert/strict';

import {
  CROSS_MARKS,
  FILES,
  FRAME_ASPECT,
  MARGIN_X,
  MARGIN_Y,
  PALACES,
  RANKS,
  RIVER_BOTTOM_RANK,
  RIVER_TOP_RANK,
  allPoints,
  buildCrossSegments,
  buildRiver,
  buildSegments,
  computeLayout,
} from '../src/geometry.js';

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

const sizes = [320, 480, 768, 1182, 1600, 2400];

console.log('geometry（标准象棋盘规格）');

check('九道直线 × 十道横线 = 90 个交叉点', () => {
  assert.equal(FILES, 9, '直线应为 9 道');
  assert.equal(RANKS, 10, '横线应为 10 道');
  const pts = allPoints();
  assert.equal(pts.length, 90, `交叉点数 ${pts.length}`);
  // 坐标不重复
  assert.equal(new Set(pts.map((p) => `${p.file},${p.rank}`)).size, 90);
});

check('布局给出 9 条直线坐标 + 10 条横线坐标', () => {
  for (const w of sizes) {
    const L = computeLayout({ width: w });
    assert.equal(L.fx.length, FILES);
    assert.equal(L.ry.length, RANKS);
  }
});

check('相邻路距相等、相邻线距相等（网格均匀）', () => {
  const L = computeLayout({ width: 1182 });
  for (let f = 1; f < FILES; f++) {
    assert.ok(Math.abs(L.fx[f] - L.fx[f - 1] - L.filePitch) < 1e-9, `第 ${f} 路间距异常`);
  }
  for (let r = 1; r < RANKS; r++) {
    assert.ok(Math.abs(L.ry[r] - L.ry[r - 1] - L.rankPitch) < 1e-9, `第 ${r} 线间距异常`);
  }
});

check('每格为正方形（规则 1.4）', () => {
  const L = computeLayout({ width: 1182 });
  assert.ok(Math.abs(L.filePitch - L.rankPitch) < 1e-9, `${L.filePitch} vs ${L.rankPitch}`);
});

check('河界在第 5、6 线之间，且横向通栏', () => {
  assert.equal(RIVER_TOP_RANK, 4);
  assert.equal(RIVER_BOTTOM_RANK, 5);
  for (const w of sizes) {
    const L = computeLayout({ width: w });
    const river = buildRiver(L);
    assert.ok(Math.abs(river.height - L.rankPitch) < 1e-9, `河界高度 ${river.height}`);
    assert.ok(Math.abs(river.width - L.boardW) < 1e-9, '河界应通栏');
    assert.equal(river.y, L.ry[4]);
  }
});

check('河界内只有最左、最右两条直线贯通', () => {
  for (const w of sizes) {
    const L = computeLayout({ width: w });
    const riverTop = L.ry[RIVER_TOP_RANK];
    const riverBottom = L.ry[RIVER_BOTTOM_RANK];
    const verticals = buildSegments(L).filter((s) => Math.abs(s.x1 - s.x2) < 1e-9);
    for (const s of verticals) {
      const crossesRiver = s.y1 <= riverTop + 1e-9 && s.y2 >= riverBottom - 1e-9;
      const isOuter = Math.abs(s.x1 - L.fx[0]) < 1e-9 || Math.abs(s.x1 - L.fx[FILES - 1]) < 1e-9;
      assert.equal(crossesRiver, isOuter, `x=${s.x1} 贯通河界=${crossesRiver} 是外框=${isOuter}`);
    }
  }
});

check('直线在河界处断开的位置正确（断口 = 第 4、5 线）', () => {
  const L = computeLayout({ width: 1182 });
  const verticals = buildSegments(L).filter((s) => Math.abs(s.x1 - s.x2) < 1e-9);
  const inner = verticals.filter((s) => Math.abs(s.x1 - L.fx[0]) > 1e-9 && Math.abs(s.x1 - L.fx[FILES - 1]) > 1e-9);
  assert.equal(inner.length, (FILES - 2) * 2, `内部直线段数 ${inner.length}`);
  for (const s of inner) {
    const okTop = Math.abs(s.y2 - L.ry[4]) < 1e-9 && Math.abs(s.y1 - L.ry[0]) < 1e-9;
    const okBottom = Math.abs(s.y1 - L.ry[5]) < 1e-9 && Math.abs(s.y2 - L.ry[RANKS - 1]) < 1e-9;
    assert.ok(okTop || okBottom, `断口不正确: ${JSON.stringify(s)}`);
  }
});

check('十道横线整幅贯通', () => {
  const L = computeLayout({ width: 1182 });
  const horizontals = buildSegments(L).filter((s) => Math.abs(s.y1 - s.y2) < 1e-9);
  assert.equal(horizontals.length, RANKS, `横线段数 ${horizontals.length}`);
  for (const s of horizontals) {
    assert.equal(s.x1, L.fx[0]);
    assert.equal(s.x2, L.fx[FILES - 1]);
  }
});

check('上下各一个九宫，位置与斜线正确', () => {
  const L = computeLayout({ width: 1182 });
  assert.equal(PALACES.length, 2);
  const upper = PALACES.find((p) => p.rank === 0);
  const lower = PALACES.find((p) => p.rank === 7);
  assert.ok(upper && lower, '九宫应位于 0..2 线与 7..9 线');
  // 九宫必须居中在第 4..6 路（0 起为 3..5）
  for (const p of PALACES) {
    assert.equal(p.file, 3, `九宫应居中，实际 file=${p.file}`);
    assert.equal(p.file + p.size, FILES - 4, '九宫右边界应为第 5 路');
  }
  const diagonals = buildSegments(L).filter((s) => s.kind === 'diagonal');
  assert.equal(diagonals.length, 4, `九宫斜线应有 4 条，实际 ${diagonals.length}`);
  // 斜线端点必须落在九宫的四个角上
  const corners = new Set();
  for (const p of PALACES) {
    for (const [f, r] of [
      [p.file, p.rank],
      [p.file + p.size, p.rank],
      [p.file, p.rank + p.size],
      [p.file + p.size, p.rank + p.size],
    ]) {
      corners.add(`${L.fx[f]},${L.ry[r]}`);
    }
  }
  for (const s of diagonals) {
    assert.ok(corners.has(`${s.x1},${s.y1}`), `斜线起点不在九宫角上: ${s.x1},${s.y1}`);
    assert.ok(corners.has(`${s.x2},${s.y2}`), `斜线终点不在九宫角上: ${s.x2},${s.y2}`);
  }
});

check('任意尺寸下格宽高比与整幅比例都保持一致', () => {
  const base = computeLayout({ width: 1182 });
  for (const w of sizes) {
    const L = computeLayout({ width: w });
    assert.ok(Math.abs(L.filePitch / L.rankPitch - base.filePitch / base.rankPitch) < 1e-9, `w=${w}`);
    assert.ok(Math.abs(L.height / L.width - FRAME_ASPECT) < 1e-9, `w=${w} 幅面比例`);
    assert.ok(Math.abs(L.padding.left / L.width - MARGIN_X / (8 + MARGIN_X * 2)) < 1e-9, `w=${w} 横向留白比例`);
    assert.ok(Math.abs(L.padding.top / L.width - MARGIN_Y / (8 + MARGIN_X * 2)) < 1e-9, `w=${w} 纵向留白比例`);
  }
});

check('给 height 时得到同样的几何', () => {
  const fromWidth = computeLayout({ width: 1182 });
  const fromHeight = computeLayout({ height: fromWidth.height });
  assert.ok(Math.abs(fromHeight.width - fromWidth.width) < 1e-9);
  assert.ok(Math.abs(fromHeight.filePitch - fromWidth.filePitch) < 1e-9);
  assert.ok(Math.abs(fromHeight.rankPitch - fromWidth.rankPitch) < 1e-9);
});

check('交叉点坐标换算可逆，snap 能吸附且拒绝越界', () => {
  const L = computeLayout({ width: 1182 });
  for (const f of [0, 4, 8]) {
    for (const r of [0, 5, 9]) {
      const { px, py } = L.pointAt(f, r);
      const back = L.pointFrom(px, py);
      assert.ok(Math.abs(back.file - f) < 1e-9 && Math.abs(back.rank - r) < 1e-9);
      const s = L.snap(px, py);
      assert.deepEqual(s, { file: f, rank: r });
    }
  }
  assert.equal(L.snap(-50, 0), null, '越界应返回 null');
  assert.equal(L.snap(0, 99999), null, '越界应返回 null');
});

check('线宽落在可读区间', () => {
  for (const w of sizes) {
    const L = computeLayout({ width: w });
    assert.ok(L.lineWidth >= 1 && L.lineWidth <= 5, `w=${w} lineWidth=${L.lineWidth}`);
    assert.ok(L.borderWidth > 0);
  }
});

check('炮位 / 兵位共 14 个"十"字标记，位置符合标准', () => {
  const cannons = [
    { file: 1, rank: 2 },
    { file: 7, rank: 2 },
    { file: 1, rank: 7 },
    { file: 7, rank: 7 },
  ];
  const soldiers = [];
  for (const rank of [3, 6]) {
    for (const file of [0, 2, 4, 6, 8]) soldiers.push({ file, rank });
  }
  const expected = [...cannons, ...soldiers].map((m) => `${m.file},${m.rank}`).sort();
  const actual = CROSS_MARKS.map((m) => `${m.file},${m.rank}`).sort();
  assert.deepEqual(actual, expected, '十字标记位置不符');

  const L = computeLayout({ width: 1182 });
  const segs = buildCrossSegments(L);
  // 每个标记 4 臂；file 0 与 file 8 上的兵位（各 2 个）贴边，各裁掉朝外 1 臂 → 56 - 4 = 52
  const expectedSegs = CROSS_MARKS.length * 4 - 4;
  assert.equal(segs.length, expectedSegs, `十字段数 ${segs.length}`);

  for (const m of CROSS_MARKS) {
    const own = segs.filter((s) => s.file === m.file && s.rank === m.rank);
    const { px, py } = L.pointAt(m.file, m.rank);
    // 所有段都必须离开交点（中心留空）且不伸出棋盘
    for (const s of own) {
      const d = Math.hypot(s.x1 - px, s.y1 - py);
      assert.ok(d > 0, '十字线段不应穿过交点');
      for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) {
        assert.ok(x >= L.boardLeft - 1e-9 && x <= L.boardRight + 1e-9, `x=${x} 出框`);
        assert.ok(y >= L.boardTop - 1e-9 && y <= L.boardBottom + 1e-9, `y=${y} 出框`);
      }
    }
  }
});

check('十字标记只出现在炮位与兵位，不侵入九宫', () => {
  const palaceFiles = new Set([3, 4, 5]);
  const palaceRanks = new Set([0, 1, 2, 7, 8, 9]);
  for (const m of CROSS_MARKS) {
    const inPalace = palaceFiles.has(m.file) && palaceRanks.has(m.rank);
    assert.ok(!inPalace, `标记 ${m.file},${m.rank} 侵入九宫`);
  }
});

check('九个交叉点一行：第 0 与第 9 线端点即棋盘边界', () => {
  const L = computeLayout({ width: 1182 });
  assert.equal(L.boardLeft, L.fx[0]);
  assert.equal(L.boardRight, L.fx[FILES - 1]);
  assert.equal(L.boardTop, L.ry[0]);
  assert.equal(L.boardBottom, L.ry[RANKS - 1]);
  assert.ok(Math.abs(L.boardW - 8 * L.filePitch) < 1e-9);
  assert.ok(Math.abs(L.boardH - 9 * L.rankPitch) < 1e-9);
});

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
