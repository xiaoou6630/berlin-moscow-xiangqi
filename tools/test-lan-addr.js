/**
 * 联机地址判断的单测。
 *
 * 背景：在域名托管（GitHub Pages / maozi.io 之类）上，界面曾经显示
 * `http://xxx.github.io:5173/` —— 那台机器上根本没有 Node 进程，
 * 这个地址是**编出来的**，朋友不可能连上。
 * 根因是拼地址时只看 location.hostname，没判断"页面是不是本机提供的"。
 *
 * 运行：node tools/test-lan-addr.js
 */
import assert from 'node:assert/strict';

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

/** 在指定的 location 下重新加载 lan.js（模块读的是全局 location） */
async function withLocation(hostname, { port = '', protocol = 'http:', origin = '' } = {}) {
  globalThis.location = {
    hostname,
    port,
    protocol,
    origin: origin || `${protocol}//${hostname}${port ? `:${port}` : ''}`,
    host: `${hostname}${port ? `:${port}` : ''}`,
    search: '',
  };
  // 加个查询串骗过模块缓存，保证每次都重新求值
  return import(`../public/src/lan.js?t=${hostname}-${port}-${Math.random()}`);
}

console.log('lan 地址');

/* ---- 本机 / 局域网页面：应当认出来，并给出真实局域网地址 ---- */
{
  const lan = await withLocation('127.0.0.1', { port: '5173' });
  check('127.0.0.1 判定为本机页面', () => assert.equal(lan.isLocalPage(), true));

  // 模拟服务器在 /api/net 上给出真实局域网 IP
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ips: ['192.168.1.5'], port: 5173 }),
  });
  const info = await lan.lanInfo();
  check('本机页面：给出真实局域网地址', () => {
    assert.equal(info.localPage, true);
    assert.equal(info.url, 'http://192.168.1.5:5173/');
  });
}

{
  const lan = await withLocation('192.168.2.101', { port: '5173' });
  check('私有网段判定为本机页面', () => assert.equal(lan.isLocalPage(), true));
}

{
  const lan = await withLocation('my-pc.local');
  check('.local 判定为本机页面', () => assert.equal(lan.isLocalPage(), true));
}

/* ---- 域名托管：必须**不**认成本机，且不能编出 :5173 ---- */
for (const host of ['xiaoou6630.github.io', 'kardsxiangqi-3flhm01cu.maozi.io', 'example.com']) {
  const lan = await withLocation(host, { port: '', protocol: 'https:' });
  check(`${host} 不判定为本机页面`, () => assert.equal(lan.isLocalPage(), false));

  // 就算托管商真的回了 /api/net（一般不会），也不能拿它编地址
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ips: ['10.0.0.9'], port: 5173 }) });
  const info = await lan.lanInfo();
  check(`${host}：给出页面自己的地址，而不是编出来的 :5173`, () => {
    assert.equal(info.localPage, false);
    assert.ok(!/:5173/.test(info.url), `地址里不该有 :5173，实际 ${info.url}`);
    assert.ok(info.url.startsWith('https://'), `应当是页面自身地址，实际 ${info.url}`);
    assert.ok(info.url.includes(host), `应当包含宿主名，实际 ${info.url}`);
  });
}

/* ---- 静态检查：main.js 不能再用 ips[0] 自己拼地址 ---- */
{
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const src = readFileSync(resolve(import.meta.dirname, '..', 'public', 'src', 'main.js'), 'utf8');
  check('main.js 使用 lanInfo() 给出的 url，而不是自己拼 ips[0]', () => {
    assert.ok(!/ips\?\.\[0\]|ips\[0\]/.test(src), 'main.js 里还在用 ips[0] 拼地址');
    assert.ok(/info\.url/.test(src), 'main.js 没用 lanInfo() 的 url');
  });
  check('lanInfo 的返回值带 localPage 标记', () => {
    const lanSrc = readFileSync(resolve(import.meta.dirname, '..', 'public', 'src', 'lan.js'), 'utf8');
    assert.ok(/localPage/.test(lanSrc), 'lanInfo 没有区分是否本机页面');
  });
}

console.log(`\n${passed} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
