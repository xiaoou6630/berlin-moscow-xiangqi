/**
 * GitHub Pages 部署形态的本地验证。
 *
 * Pages 会把仓库原样放到 https://<user>.github.io/<repo>/ 下，
 * 所以整站其实挂在子路径里。这个脚本照搬那个结构：
 *   把仓库（含 index.html 与 public/、src/）复制到临时目录，
 *   用内置服务器以 "/<repo>/" 前缀提供，然后真浏览器加载并断言资源全部 200。
 *
 * 运行：node tools/test-pages.js
 */
import { createServer } from 'node:http';
import {
  createReadStream, statSync, mkdtempSync, rmSync, readdirSync, mkdirSync, copyFileSync, existsSync,
} from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = 'berlin-moscow-xiangqi'; // 模拟的仓库名（= Pages 子路径）
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = 9488 + (process.pid % 8);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 1. 搭一个 Pages 形态的站点 ---------------- */
const site = mkdtempSync(join(tmpdir(), 'pages-'));
const siteRoot = join(site, REPO);

/**
 * 自己实现递归复制。
 * ⚠️ 不要用 node 的 fs.cpSync：本机 Windows + Node 24 上复制 public/ 会让进程
 * 直接崩掉（exit code -1073740791 = STATUS_STACK_BUFFER_OVERRUN，无任何报错）。
 * tools/build.js 里也是同样的手写实现。
 */
function copyTree(src, dst) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dst, name));
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

mkdirSync(siteRoot, { recursive: true });
for (const item of ['index.html', 'public', 'src', 'README.md']) {
  const src = join(ROOT, item);
  if (existsSync(src)) copyTree(src, join(siteRoot, item));
}
console.log(`  （临时站点: ${siteRoot}）`);

const requested = [];
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  requested.push(urlPath);
  if (!urlPath.startsWith(`/${REPO}/`)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404');
    return;
  }
  let rel = urlPath.slice(REPO.length + 2);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const full = resolve(site, REPO, rel);
  if (!full.startsWith(resolve(site, REPO) + sep) && full !== resolve(site, REPO)) {
    res.writeHead(403).end('403');
    return;
  }
  try {
    const st = statSync(full);
    if (!st.isFile()) throw new Error('not file');
    res.writeHead(200, { 'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream', 'content-length': st.size });
    createReadStream(full).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404 ' + rel);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/${REPO}/`;

/* ---------------- 2. 真浏览器加载 ---------------- */
const profile = join(site, '.edge');
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

console.log('pages 部署形态');

try {
  let wsUrl = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* 等 */ }
    await sleep(250);
  }
  if (!wsUrl) throw new Error('Edge 没起来');

  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const consoleErrors = [];
  const failedRequests = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
    if (m.method === 'Network.loadingFailed') {
      failedRequests.push(`${m.params.type} ${m.params.errorText}`);
    }
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      consoleErrors.push(m.params.entry.text);
    }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Log.enable', {}, S);
  await send('Network.enable', {}, S);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
    return r.result?.value;
  };

  await send('Page.navigate', { url: BASE }, S);
  await sleep(5000);

  await check('子路径下入口页能加载', async () => {
    const title = await ev(`document.title`);
    if (!title) throw new Error('标题为空，页面没加载');
  });

  await check('选边界面渲染出两个阵营（模块解析成功）', async () => {
    const n = await ev(`document.querySelectorAll('.faction').length`);
    if (n !== 2) throw new Error(`.faction 数量 = ${n}，说明 main.js 或其依赖没加载成功`);
  });

  await check('四种引擎档位都在', async () => {
    const n = await ev(`document.querySelectorAll('#levelRow .level').length`);
    if (n !== 4) throw new Error(`档位数量 = ${n}`);
  });

  await check('阵营头像图片能加载', async () => {
    const info = await ev(`(() => {
      const im = document.querySelector('.faction img');
      return { src: im?.getAttribute('src'), w: im?.naturalWidth ?? 0 };
    })()`);
    if (!info.w) throw new Error(`头像没加载出来: ${JSON.stringify(info)}`);
  });

  await check('子路径下能开局并渲染棋盘（含美术资源）', async () => {
    await ev(`document.querySelector('.faction[data-id="soviet"]').click()`);
    await sleep(150);
    await ev(`document.getElementById('startBtn').click()`);
    await sleep(4000);
    const st = await ev(`(() => {
      const k = window.__kards;
      return { started: !!k.state.game, sprites: k.state.view?.sprites?.size ?? 0,
               canvas: [document.getElementById('board').width, document.getElementById('board').height] };
    })()`);
    if (!st.started || st.sprites !== 32) throw new Error(`开局异常: ${JSON.stringify(st)}`);
  });

  await check('棋盘内空白格画上了背景（不是纯黑）', async () => {
    const px = await ev(`(() => {
      const k = window.__kards, v = k.state.view, c = document.getElementById('board');
      const g = c.getContext('2d');
      const dpr = c.width / v.layout.width;
      const p = v.pointAt(1.5, 5);
      const d = g.getImageData(Math.round(p.px * dpr), Math.round(p.py * dpr), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    })()`);
    const lum = 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
    if (px[3] === 0) throw new Error('该处透明，背景没画上');
    if (lum < 25) throw new Error(`该处过暗 (${px})，背景可能没画上`);
  });

  await check('子路径下三种模式按钮都在', async () => {
    const n = await ev(`document.querySelectorAll('#modeRow .level').length`);
    if (n !== 3) throw new Error(`模式按钮数量 = ${n}，应为 3`);
  });

  await check('没有资源 404（/api/net 探测失败属预期）', async () => {
    // /api/net 是服务器专属接口：静态托管上必然 404，
    // 前端就是靠它判断"没有服务器、联机不可用"，不算错误。
    const bad = requested.filter((u) => !/\/$|\/index\.html$/.test(u) && !/\/api\/net/.test(u));
    const missing = [];
    for (const u of new Set(bad)) {
      const r = await fetch(`http://127.0.0.1:${PORT}${u}`, { method: 'HEAD' }).catch(() => null);
      if (!r || r.status !== 200) missing.push(`${u} → ${r?.status ?? 'ERR'}`);
    }
    if (missing.length) {
      console.error('  实际请求过的路径:', JSON.stringify([...new Set(requested)], null, 1).slice(0, 1200));
      throw new Error(`有 ${missing.length} 个资源取不到:\n      ${missing.slice(0, 8).join('\n      ')}`);
    }
  });

  await check('没有意外的 JS 报错 / 请求失败', async () => {
    const errs = consoleErrors.filter((e) => !/favicon|\/api\/net|404/i.test(e));
    const fails = failedRequests.filter((f) => !/favicon/i.test(f));
    if (errs.length || fails.length) {
      throw new Error(`console: ${errs.slice(0, 3).join(' | ')}  请求失败: ${fails.slice(0, 3).join(' | ')}`);
    }
  });
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  edge.kill();
  server.close();
  await sleep(500);
  try { rmSync(site, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
