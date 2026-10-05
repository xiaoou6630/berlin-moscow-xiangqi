/** 资源加载：一次性把卡面、头像、背景读进内存，带进度回调。 */

const cache = new Map();
const tinted = new Map();

/**
 * 统一成相对 public/ 的路径。
 * theme.js 里写的是 `cards/soviet/pawn.png`，加载时统一补上 `assets/` 前缀，
 * 这样预加载的 key 与绘制时查找的 key 一定一致（曾经在这里踩过坑）。
 */
export function normalizeAssetPath(url) {
  return url.startsWith('assets/') ? url : `assets/${url}`;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`加载失败: ${url}`));
    img.src = `./${url}`;
  });
}

/**
 * @param {string[]} urls 相对 public/ 的路径（可带或不带 assets/ 前缀）
 * @param {(done:number,total:number)=>void} [onProgress]
 */
export async function preload(urls, onProgress) {
  const list = [...new Set(urls.map(normalizeAssetPath))];
  let done = 0;
  await Promise.all(
    list.map(async (url) => {
      if (!cache.has(url)) cache.set(url, await loadImage(url));
      done++;
      onProgress?.(done, list.length);
    }),
  );
}

export function img(url) {
  const key = normalizeAssetPath(url);
  const found = cache.get(key);
  if (!found) throw new Error(`资源未预加载: ${key}`);
  return found;
}

/**
 * 返回"被将死"用的红色版本（只生成一次并缓存）。
 * 做法：原图 → 去饱和 → 叠加红色（source-atop），保留细节。
 */
export function reddened(url) {
  const key = normalizeAssetPath(url);
  if (tinted.has(key)) return tinted.get(key);
  const src = img(key);
  const c = document.createElement('canvas');
  c.width = src.naturalWidth || src.width;
  c.height = src.naturalHeight || src.height;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'saturation';
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height); // 去色
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(196, 24, 18, 0.78)';
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'source-over';
  tinted.set(key, c);
  return c;
}

/** 收集一个阵营所需的所有资源路径 */
export function urlsForFactions(factions) {
  const list = ['assets/background.jpg'];
  for (const f of factions) {
    list.push(f.portrait);
    for (const p of Object.values(f.cards)) list.push(p);
  }
  return list;
}
