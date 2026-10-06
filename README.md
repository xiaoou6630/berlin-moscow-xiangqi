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
| 局域网对战 | 同一 WiFi 下，一台电脑跑服务器、两台设备打开同一个网址 |

点自己的棋子 → 高亮可走点 → 点亮起的点落子。
**上一手会标出来**：起点蓝虚框、终点橙实框，一眼看到对方刚把哪个子挪到哪去了。
执黑时整盘转 180°，所以你永远在自己的下方。
被将死的一方：将/帅变红 → 顺时针 90° 翻倒 → 结算。

## 本地运行

```bash
npm start
```

零依赖（只用 Node 内置模块）。`npm start` 会先构建再起服务，终端会打印本机
局域网地址，同一 WiFi 下的手机/电脑打开那个地址就能联机（只有这台电脑需要跑 Node）。

改完 `public/` 里的东西想跳过构建直接看效果，用 `npm run dev`。

### 局域网对战怎么开

1. 一台电脑跑 `npm start`，记下它打印的地址，例如 `http://192.168.2.101:5173/`
2. **两台设备**（另一台可以是手机）都打开这个地址
3. 一方点「我建房 · 局域网」，把**房间号**告诉另一方
4. 另一方点「我加入 · 局域网」，地址填同一个 `192.168.2.101:5173`，再填房间号
5. 房主点「开始对局」，房主执红先行

> 浏览器不能自己"监听"连接，所以联机必须有一台设备跑服务器 —— 这是浏览器的
> 安全限制，不是配置问题。但只有**一台**需要；另一台打开同一个网址即可，不用装东西。

> 连不上通常是防火墙没放行 Node。Windows 第一次运行会弹网络授权，要选「允许」。

> **在线版（GitHub Pages）只能单人和两人同机**：那是静态托管、没有服务器。
> 要联机就跑本地这个。

```bash
npm run build    # 组装到 build/（纯复制，无打包/转译）
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
npm test                  # 入口页 + 几何 + 渲染 + 引擎 + 构建产物 + 服务端
npm run test:lan          # 局域网协议
npm run test:browser      # 真浏览器：单人 / 两人同机
npm run test:browser:lan  # 真浏览器：双页面对战
npm run test:narrow       # 窄窗口下 32 张牌都不能被画布裁掉
npm run test:pages        # GitHub Pages 子路径部署形态
```

`test:browser*`、`test:narrow` 与 `test:pages` 需要 Edge，用无头浏览器真的点按钮、
真的点棋盘，并导出 canvas 像素核对。`test:narrow` 专门盯"只在特定窗口尺寸才出现"
的问题 —— 卡牌被裁掉就是这一类。

## 部署

### GitHub Pages

仓库自带 `.github/workflows/deploy-pages.yml`，推到 `main` 自动发布到 Pages。
纯静态、**无构建步骤**，直接把仓库原样发布。首次需要在
Settings → Pages → Source 选 GitHub Actions。

### 其他静态托管 / 第三方编译平台

这类平台（Docker 构建等）通常假定 `npm install` 后会产出 `build/`，
所以 `package.json` 里挂了 `postinstall: npm run build`，
也可以用 `npm run build` 手动产出。`build/` 就是仓库根的一份副本：

```
build/index.html     入口页
build/public/        网页、样式、脚本、美术素材
build/src/           共享引擎
build/.nojekyll
```

**美术素材必须一起提交**，否则产物会缺图 —— `npm run test:build` 会校验这一点。

## 素材与版权

**Berlin vs Moscow Xiangqi** was created under 1939 Games' "Community content policy"
policy using assets owned by 1939 Games. 1939 Games does not endorse or sponsor this project.

棋子卡面、头像与背景底图来自游戏 **KARDS**（1939 Games），版权归 1939 Games 所有。
本项目是**非商业**的爱好者作品：不含广告、不收费、无任何付费墙。
象棋引擎、棋盘绘制、局域网联机均为原创实现，仅卡面作为皮肤使用。

**代码**以 MIT 许可发布（见 `LICENSE`）。美术素材**不在** MIT 范围内，
其使用遵循 1939 Games 的
[KARDS Community License](https://support.kards.com/hc/en-us/articles/360027838532-KARDS-Community-License)。
该许可可被 1939 Games 随时撤销；若被要求，本项目将立即下架。
