# 中国象棋 · 柏林 vs 莫斯科

KARDS 风格的中国象棋。棋盘按《中国象棋竞赛规则》的标准规格绘制，棋子用二战卡面，
支持**单人打引擎**、**两人同一台设备**、**局域网对战**三种玩法。

> 名字：`berlin-moscow-xiangqi`（柏林对莫斯科 · 象棋）
> 在线试玩（单人 / 两人同机）：https://xiaoou6630.github.io/berlin-moscow-xiangqi/

## 跑起来

```bash
npm start
```

零依赖，只用 Node 内置模块。启动后终端会打印：

```
棋盘已启动 → http://127.0.0.1:5173/
局域网（同一 WiFi 下，另一台设备打开这个地址即可联机）：
  http://192.168.x.x:5173/
```

## 三种模式

### 1. 同一台设备（单人打引擎）
选一方 + 选引擎档位。勾上「两人同机」则红黑都由人操作，不用引擎。

### 2. 两人同一台手机 / 电脑
勾选「两人同机 → 开始对局」。左上角是上方那一方，左下角是下方那一方，
**谁该走谁的头像亮起**；红黑轮流点自己的子即可。

### 3. 局域网对战（必须同一个 WiFi）
- **建房方**：选「我建房 · 局域网」，房间会自动开好，屏幕上出现
  `http://192.168.x.x:5173/` 和房间号，把这两个发给朋友。
- **加入方**：选「我加入 · 局域网」，填房主地址（如 `192.168.1.5:5173`）
  和房间号 → 点「连接并加入」。
- 双方就位后，**房主**点「开始对局」。房主执红先行。

服务端做权威校验：非法着法、抢先走子都会被拒绝；局面以服务端广播为准。

> 连不上通常是防火墙没放行 Node。Windows 上第一次运行会弹网络授权，要选「允许」。
> 装了 VMware / VirtualBox 的机器会有多张虚拟网卡，本项目已按网卡名+网段排序，
> 优先给出真实 WiFi 的地址。

## 玩法

点自己的棋子 → 高亮可走点 → 点亮起的点落子。
被将死的一方：**将/帅变红 → 顺时针 90° 翻倒 → 弹出结算**。
顶部 HUD 显示对手头像、模式、当前该谁走。

**执黑时整盘转 180°**，所以你永远在自己的下方（象棋里黑方把棋盘转过来看是常规做法）。

## 项目结构

```
index.html                入口页（GitHub Pages 从根目录取；靠 <base href="./public/"> 指到 public/）
src/                      共享代码：引擎 / 几何 / 棋盘绘制（浏览器与 Node 共用同一份）
  geometry.js             标准棋盘几何：9 路 × 10 线 = 90 交叉点、河界、九宫、炮位兵位十字
  board.js                把棋盘画到 Canvas
  engine/rules.js         走子规则、将军、将死、困毙、飞将
  engine/ai.js            Alpha-Beta 搜索 + 位置评估，四档难度

public/                   网页（= 站点根目录）
  index.html              与根目录那份内容一致（Pages 用根那份，本地开发用这份）
  styles.css              选边 / 模式 / 局域网面板 / HUD / 结算 / 横幅
  src/main.js             主控制器（三种模式）
  src/theme.js            阵营、棋子 → 卡面映射、卡牌尺寸、背景参数
  src/assets.js           素材预加载 + "被将死"用的红色版本
  src/lan.js              联机客户端（WebSocket 封装、地址解析、连接超时）
  src/ui/board-view.js    棋盘/棋子渲染、走子动画、将死翻倒动画
  assets/                 由 tools/build-assets.py 从 art/ 生成

art/                      美术素材原件
  soviet/                 苏联（红方）
  germany/                德国（黑方）+ 背景底图 R-C.jpg

server/                   零依赖服务端（仅局域网对战需要，Pages 上不可用）
  server.js               静态文件 + /api/net + WS 升级
  ws.js                   自己实现的 WebSocket（RFC 6455 子集）
  rooms.js                局域网房间：座位分配、权威着法校验、状态广播

tools/                    构建与测试
```

## 素材映射

| 棋子 | 苏联（红） | 德国（黑） |
|---|---|---|
| 帅/将 | 莫斯科 | 阿登 |
| 士 | 近卫步兵第 272 团 | 三号坦克 H 型 |
| 相/象 | 战术撤退 ⚠️ | 步兵第百十四联队 |
| 马 | 库班哥萨克第 4 团 | 第 15 侦察营 |
| 车 | IS-2 | 虎式坦克 H 型 |
| 炮 | 喀秋莎 | 利奥波德 |
| 兵/卒 | 步兵第 554 团 | 第 18 步兵团 |

⚠️ 苏联没有专属的"相/象"单位，暂时用「战术撤退」。要换就改
`public/src/theme.js` 的 `soviet.cards.elephant`，然后 `npm run assets`。

> 注：「近卫步兵第 272 团」文件放在 `art/germany/` 里，但它是苏联单位；
> 构建脚本在两个目录里都会找素材。

素材改动后重新生成：

```bash
npm run assets        # 需要 Python + Pillow
```

## 测试

```bash
npm test                  # 几何 + 渲染 + 引擎 + 服务端健壮性，共 66 项
npm run test:lan          # 局域网协议（真开两个 WebSocket 客户端），14 项
npm run test:browser      # 真浏览器单机/同机流程，30 项
npm run test:browser:lan  # 真浏览器双页面对战，13 项
npm run test:pages        # GitHub Pages 子路径部署形态，8 项
```

`test:browser*` 与 `test:pages` 需要 Edge 与已在跑的服务器（`test:pages` 会自建临时站点）。
它们用无头 Edge + CDP 驱动：真的点按钮、真的点棋盘、真的等引擎应招，
并把 canvas 像素导出成 PNG 核对，而不是只检查代码。

## 部署到 GitHub Pages

仓库自带 `.github/workflows/deploy-pages.yml`，推到 `main` 后自动发布。
**没有任何构建步骤** —— 纯静态文件直接发布，所以不会卡在编译上
（这也是把美术素材一起提交的原因：第三方编译站拿不到素材就会失败）。

首次需要在仓库 Settings → Pages → Source 选 **GitHub Actions**。

站点根是 `/<repo>/` 子路径，所有路径都按子路径验证过（见 `npm run test:pages`）。

> 联机对战需要 Node 服务器，Pages 上无法使用；单人 / 两人同机完全正常。

## 已知取舍 / 踩过的坑

- **棋盘是 9 路 × 10 线**（90 交叉点），棋子落在**交叉点**上，不是格子中心
- 河界文字沿用项目主题的 **柏林 / 莫斯科**（传统棋盘是「楚河 汉界」），
  改 `src/geometry.js` 的 `RIVER_LABELS` 即可
- 卡面**完整显示不裁剪**；相邻两路之间的重叠用绘制顺序处理（被压住的是插画而不是牌名）
- ⚠️ **不要用 `ctx.filter = 'brightness(...)'`**：实测在部分环境下会让这次
  `drawImage` 被合成成纯黑（背景等于没画）。亮度要调就在构建阶段调。
- ⚠️ **`drawBoard()` 里不能无条件 `clearRect`**：caller 会先把背景底图画好，
  清屏会把底图整幅擦掉。
- ⚠️ **页面用了 `<base href="./public/">`**，而 `<base>` 只影响 HTML 里的 URL，
  **不影响 ES module 的相对解析**。所以跨目录引用共享代码用 import map 的
  `#shared/` 别名，不要用 `../../..`（在 Pages 子路径下会解析错位）。
- ⚠️ 本机 Windows + Node 24 上，`fs.cpSync` 复制 `public/` 目录会让进程直接崩
  （`STATUS_STACK_BUFFER_OVERRUN`，无报错），所以 `tools/test-pages.js` 改用 PowerShell 复制。
