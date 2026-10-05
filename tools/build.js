/**
 * 构建：把站点组装到 build/。
 *
 * 这个项目是纯静态的（无需打包 / 压缩 / 转译），所以"构建"就是按站点布局
 * 复制文件。之所以要有这一步，是因为第三方编译平台（Docker 构建等）
 * 普遍假定 `npm install` 之后会产出 build/，没有就会直接失败：
 *   COPY --from=build /src/build /   →  "/src/build": not found
 *
 * 产物布局（= 仓库根的一个副本，站点根是 build/）：
 *   build/index.html        入口页（含 <base href="./public/"> 与 import map）
 *   build/public/           网页、样式、脚本、美术素材
 *   build/src/              共享引擎 / 几何 / 棋盘绘制
 *   build/.nojekyll         关掉 Jekyll（Pages 用）
 *
 * 这样 build/ 与仓库根的目录结构完全一致，服务器 / Pages 都能直接服务。
 *
 * 运行：npm run build
 */
import {
  copyFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build');

/** 必须进产物目录的内容 */
const ENTRIES = ['index.html', 'public', 'src'];

/**
 * 自己实现递归复制。
 *
 * ⚠️ 不要用 node 的 fs.cpSync：在本机 Windows + Node 24 上复制 public/ 会让
 * 进程直接崩掉（exit code -1073740791 = STATUS_STACK_BUFFER_OVERRUN，
 * 而且不打任何错误信息）。手写这十几行反而稳。
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

/** 递归数文件 */
function countFiles(dir) {
  const st = statSync(dir);
  if (!st.isDirectory()) return 1;
  let n = 0;
  for (const name of readdirSync(dir)) n += countFiles(join(dir, name));
  return n;
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  let total = 0;
  for (const entry of ENTRIES) {
    const src = join(ROOT, entry);
    if (!existsSync(src)) {
      console.error(`缺少 ${entry}，无法构建`);
      process.exit(1);
    }
    copyTree(src, join(OUT, entry));
    const n = countFiles(src);
    total += n;
    console.log(`  + ${entry}  (${n})`);
  }

  // Jekyll 会忽略下划线开头的文件，直接关掉
  writeFileSync(join(OUT, '.nojekyll'), '');
  total += 1;
  console.log('  + .nojekyll');

  // 顺手把产物根路径打出来，方便第三方平台日志里确认
  const size = totalBytes(OUT);
  console.log(`\n构建完成 → ${relative(ROOT, OUT)}/  ${total} 个文件  ${(size / 1048576).toFixed(1)} MB`);
}

function totalBytes(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    n += st.isDirectory() ? totalBytes(p) : st.size;
  }
  return n;
}

main();
