/**
 * 构建产物校验。
 *
 * 第三方编译平台（Docker 等）普遍假定 `npm install` 后会产出 build/，
 * 而且是 `COPY --from=build /src/build /` 这种整目录用法。
 * 所以这里断言：
 *   1. npm run build 能跑通并产出 build/
 *   2. 产物布局与仓库根一致（index.html + public/ + src/ + .nojekyll）
 *   3. 产物是自洽的 —— 入口页引用的每个资源都在产物里，不缺文件
 *   4. 产物里没有把仓库绝对路径写进去（换机器就废）
 *
 * 运行：node tools/test-build.js
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');

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

console.log('build');

/* 先真跑一次构建，确保脚本本身能用 */
const built = spawnSync(process.execPath, [join(ROOT, 'tools', 'build.js')], {
  cwd: ROOT,
  encoding: 'utf8',
});
check('npm run build 能跑通', () => {
  assert.equal(built.status, 0, `构建退出码 ${built.status}\n${built.stderr?.slice(0, 300)}`);
});

/** 递归列出产物里的文件（相对 build/ 的路径，用 / 分隔） */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

const files = existsSync(BUILD) ? listFiles(BUILD) : [];

check('产出 build/index.html', () => {
  assert.ok(files.includes('index.html'), `产物里没有 index.html，实际顶层: ${files.slice(0, 8)}`);
});

check('产物布局与仓库根一致（index.html + public/ + src/ + .nojekyll）', () => {
  for (const need of ['index.html', '.nojekyll']) {
    assert.ok(files.includes(need), `缺 ${need}`);
  }
  assert.ok(files.some((f) => f.startsWith('public/')), '缺 public/');
  assert.ok(files.some((f) => f.startsWith('src/')), '缺 src/');
});

check('美术素材进了产物（第三方编译站没素材就会失败）', () => {
  const cards = files.filter((f) => /^public\/assets\/cards\/\w+\/\w+\.(png|webp)$/.test(f));
  assert.equal(cards.length, 14, `卡面数量 ${cards.length}，应为 14`);
  assert.ok(files.includes('public/assets/background.webp'), '缺背景底图');
  const portraits = files.filter((f) => /^public\/assets\/portraits\/\w+\.png$/.test(f));
  assert.equal(portraits.length, 2, `头像数量 ${portraits.length}，应为 2`);
});

check('入口页引用的资源在产物里都存在', () => {
  const html = readFileSync(join(BUILD, 'index.html'), 'utf8');
  const refs = [
    ...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g),
  ].map((m) => m[1]).filter((r) => !r.startsWith('//'));
  const missing = refs.filter((r) => !files.includes(r) && !files.includes(`public/${r}`));
  // <base href="./public/"> 本身指目录，单独排除
  const miss = missing.filter((r) => r !== 'public/');
  assert.equal(miss.length, 0, `入口页引用但产物里没有: ${miss.join(', ')}`);
});

check('卡面映射声明的图都在产物里', () => {
  const theme = readFileSync(join(ROOT, 'public', 'src', 'theme.js'), 'utf8');
  const declared = [...theme.matchAll(/cards\/(\w+)\/(\w+\.(?:png|webp))/g)].map((m) => `public/assets/cards/${m[1]}/${m[2]}`);
  assert.ok(declared.length >= 14, `theme.js 里只解析到 ${declared.length} 个卡面`);
  const missing = [...new Set(declared)].filter((p) => !files.includes(p));
  assert.equal(missing.length, 0, `theme.js 声明了但产物里没有: ${missing.join(', ')}`);
});

check('产物里没有写死本机绝对路径', () => {
  const offenders = [];
  for (const f of files) {
    if (!/\.(js|html|css|json)$/.test(f)) continue;
    const text = readFileSync(join(BUILD, f), 'utf8');
    // Windows 盘符路径 或 本仓库所在目录名
    if (/[A-Za-z]:\\/.test(text) || /E:\/daima/i.test(text)) offenders.push(f);
  }
  assert.equal(offenders.length, 0, `这些文件写死了绝对路径: ${offenders.join(', ')}`);
});

check('产物里带 .nojekyll（Pages 不跑 Jekyll）', () => {
  assert.ok(files.includes('.nojekyll'));
});

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
