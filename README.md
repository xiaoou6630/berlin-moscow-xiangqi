# 柏林 vs 莫斯科 · 中国象棋

KARDS 风格的中国象棋。棋盘按标准规格绘制（9 路 × 10 线 = 90 个交叉点），
棋子用二战卡面。

**在线玩：** https://xiaoou6630.github.io/berlin-moscow-xiangqi/

## 玩法

进入后先选阵营，再选模式：

| 模式 | 说明 |
|---|---|
| 同一台设备 | 单人打引擎，四档难度 |
| 两人同机 | 勾选「两人同机」，红黑都由人操作 |
| 局域网对战 | 同一 WiFi 下，一台建房、一台加入 |

点自己的棋子 → 高亮可走点 → 点亮起的点落子。
执黑时整盘转 180°，所以你永远在自己的下方。
被将死的一方：将/帅变红 → 顺时针 90° 翻倒 → 结算。

## 本地运行

```bash
npm start
```

零依赖（只用 Node 内置模块）。终端会打印本机局域网地址，同一 WiFi 下的
手机/电脑打开即可联机。

> **局域网对战需要本机跑 Node。** 在线版是静态托管，没有后端，所以联机选项
> 会自动禁用，只有单人和两人同机可用。

```bash
npm run assets   # 改了 art/ 里的素材后重新生成 public/assets/（需要 Python + Pillow）
```

## 结构

```
index.html        入口页（Pages 从根目录取；<base href="./public/"> 指到 public/）
src/              共享代码：geometry.js 棋盘几何 · board.js 绘制 ·
                  engine/rules.js 规则 · engine/ai.js 搜索
public/           网页：main.js 控制器 · theme.js 卡面映射 ·
                  ui/board-view.js 渲染 · lan.js 联机 · assets/ 素材成品
art/              素材原件（soviet/、germany/，含背景底图 R-C.jpg）
server/           零依赖服务端：静态文件 + /api/net + 自实现的 WebSocket 房间
tools/            构建与测试
```

跨目录引用共享代码用 import map 的 `#shared/` 别名
（`package.json` 的 `imports` 里声明了同名映射，Node 与浏览器共用一套）。

## 棋子映射

| 棋子 | 苏联（红） | 德国（黑） |
|---|---|---|
| 帅/将 | 莫斯科 | 阿登 |
| 士 | 近卫步兵第 272 团 | 三号坦克 H 型 |
| 相/象 | 战术撤退 | 步兵第百十四联队 |
| 马 | 库班哥萨克第 4 团 | 第 15 侦察营 |
| 车 | IS-2 | 虎式坦克 H 型 |
| 炮 | 喀秋莎 | 利奥波德 |
| 兵/卒 | 步兵第 554 团 | 第 18 步兵团 |

改映射后跑 `npm run assets`，再用 `python tools/check-mapping.py` 核对成品与源图是否逐像素一致。

## 测试

```bash
npm test                  # 几何 + 渲染 + 引擎 + 服务端健壮性
npm run test:lan          # 局域网协议
npm run test:browser      # 真浏览器：单人 / 两人同机
npm run test:browser:lan  # 真浏览器：双页面对战
npm run test:pages        # GitHub Pages 子路径部署形态
```

`test:browser*` 与 `test:pages` 需要 Edge，用无头浏览器真的点按钮、真的点棋盘，
并导出 canvas 像素核对。

## 部署

仓库自带 `.github/workflows/deploy-pages.yml`，推到 `main` 自动发布到 Pages。
纯静态、**无构建步骤**。首次需要在 Settings → Pages → Source 选 GitHub Actions。

## 素材与版权

棋子卡面、头像与背景底图来自游戏 **KARDS**（1939 Games），版权归 1939 Games 所有，
本项目是非商业的爱好者作品。

**代码**以 MIT 许可发布（见 `LICENSE`）。美术素材**不在** MIT 范围内，
使用者需自行确认是否符合 KARDS 的社区使用条款。
