/**
 * 入口页一致性 + 版权声明存在性检查。
 *
 * index.html 有两份（仓库根给 GitHub Pages 取，public/ 给本地开发服务器），
 * 内容必须完全一致，否则线上/本地行为会分叉。
 * 另外按 KARDS 社区许可第 6 条，指定声明必须显著展示，这里一并断言。
 *
 * 运行：node tools/check-index.js
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const files = {
  root: readFileSync(resolve(ROOT, 'index.html'), 'utf8'),
  public: readFileSync(resolve(ROOT, 'public', 'index.html'), 'utf8'),
};

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

console.log('index 一致性');

check('两份 index.html 内容完全一致', () => {
  const a = files.root.replace(/\r\n/g, '\n');
  const b = files.public.replace(/\r\n/g, '\n');
  if (a !== b) {
    throw new Error('根目录与 public/ 的 index.html 不一致，改一份必须同步另一份');
  }
});

check('带 <base href="./public/">（Pages 子路径下才能解析资源）', () => {
  for (const [k, html] of Object.entries(files)) {
    if (!/<base\s+href="\.\/public\/"\s*\/?>/.test(html)) {
      throw new Error(`${k} 缺少 base 标签`);
    }
  }
});

check('带 import map 的 #shared/ 别名', () => {
  for (const [k, html] of Object.entries(files)) {
    if (!html.includes('"#shared/"')) throw new Error(`${k} 缺少 #shared/ 映射`);
  }
});

check('包含 1939 Games 社区许可第 6 条要求的声明', () => {
  // 原文：[项目名] was created under 1939 Games' "Community content policy"
  //       policy using assets owned by 1939 Games.
  //       1939 Games does not endorse or sponsor this project.
  const required = [
    /created under 1939 Games/,
    /Community content policy/,
    /using assets owned by 1939 Games/,
    /does not endorse or sponsor this project/,
  ];
  for (const [k, html] of Object.entries(files)) {
    for (const re of required) {
      if (!re.test(html)) throw new Error(`${k} 的声明缺少片段: ${re}`);
    }
  }
});

check('声明不是 hidden（许可要求显著展示）', () => {
  for (const [k, html] of Object.entries(files)) {
    const m = /<footer[^>]*id="licenseNotice"[^>]*>/.exec(html);
    if (!m) throw new Error(`${k} 找不到声明元素`);
    if (/\bhidden\b/.test(m[0])) throw new Error(`${k} 的声明被 hidden 了`);
  }
});

check('README 里也有同样的声明', () => {
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  for (const re of [/created under 1939 Games/, /does not endorse or sponsor this project/]) {
    if (!re.test(readme)) throw new Error(`README 缺少: ${re}`);
  }
});

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
