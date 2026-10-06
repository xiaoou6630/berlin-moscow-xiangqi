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

check('页面提供版权与许可说明的入口（链接文字明确）', () => {
  for (const [k, html] of Object.entries(files)) {
    // 直链 1939 Games 官方的社区许可页面
    const m = /<a[^>]*href="(https:\/\/support\.kards\.com\/[^"]*)"[^>]*>([^<]+)<\/a>/.exec(html);
    if (!m) throw new Error(`${k} 里没有指向 1939 Games 社区许可页面的链接`);
    if (!/KARDS-Community-License/.test(m[1])) {
      throw new Error(`${k} 的链接不是社区许可页面: ${m[1]}`);
    }
    // 链接文字要能表明这是许可，否则不算"显著展示"
    if (!/许可|license|版权|copyright/i.test(m[2])) {
      throw new Error(`${k} 的链接文字不明确: "${m[2]}"`);
    }
  }
});

check('声明区用中文点明素材版权归属', () => {
  for (const [k, html] of Object.entries(files)) {
    if (!/1939 Games/.test(html)) throw new Error(`${k} 没有提到 1939 Games`);
    if (!/版权|非商业/.test(html)) throw new Error(`${k} 没有说明版权/非商业性质`);
  }
});

check('声明区不是 hidden（许可要求显著展示）', () => {
  for (const [k, html] of Object.entries(files)) {
    const m = /<footer[^>]*id="licenseNotice"[^>]*>/.exec(html);
    if (!m) throw new Error(`${k} 找不到声明元素`);
    if (/\bhidden\b/.test(m[0])) throw new Error(`${k} 的声明被 hidden 了`);
  }
});

check('README 里有 1939 Games 要求的声明全文', () => {
  // 那段英文原文按许可要求放在 README 里（页面底部只留中文提示 + 官方链接）
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  for (const re of [
    /created under 1939 Games/,
    /Community content policy/,
    /using assets owned by 1939 Games/,
    /does not endorse or sponsor this project/,
  ]) {
    if (!re.test(readme)) throw new Error(`README 缺少声明片段: ${re}`);
  }
});

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
