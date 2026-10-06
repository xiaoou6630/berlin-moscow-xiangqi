/**
 * 客户端联机：局域网 WebSocket 封装。
 *
 * 只负责"连上、收发消息"，具体怎么落到棋局由 main.js 决定。
 */

const DEFAULT_PORT = 5173;

/**
 * 本机是否跑着 Node 服务器。
 *
 * 静态托管（GitHub Pages / 各种第三方编译站）上只有前端文件，
 * /api/net 会 404，也就**根本不可能联机**。
 * 界面必须据此把联机选项藏起来，否则会出现
 * "http://xxx.github.io:5173/ 正在等待对手" 这种荒唐状态。
 */
let serverAvailable = null;

export async function probeServer() {
  if (serverAvailable !== null) return serverAvailable;
  try {
    const r = await fetch('/api/net', { cache: 'no-store' });
    serverAvailable = r.ok;
  } catch {
    serverAvailable = false;
  }
  return serverAvailable;
}

export function isServerAvailable() {
  return serverAvailable === true;
}

/** 当前页面所在的主机名（房主自己就是 host） */
export function currentHost() {
  return location.hostname || '127.0.0.1';
}

/**
 * 这个页面是不是**由本机服务器**提供的？
 *
 * 只有这种情况才能拿到真实的局域网 IP。判断依据是"主机名是不是本机地址"：
 * 回环、私有网段、.local、或者干脆没有域名（file:// 打开）。
 *
 * 反例：`xxxx.maozi.io`、`xxx.github.io` 这类**真实域名托管** —— 页面是从
 * 托管商那里来的，那台机器上并没有你的 Node 进程。以前不判断这一条，
 * 于是界面上出现了 `http://xxx.github.io:5173/` 这种**根本不存在**的地址。
 */
export function isLocalPage() {
  const host = location.hostname || '';
  if (!host) return true; // file:// 打开
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '127.0.0.1' || host.startsWith('127.')) return true;
  if (host === '[::1]' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * 拼出"让朋友在浏览器打开"的地址。
 *
 * @returns {Promise<{ips: string[], port: number, localPage: boolean, url: string}>}
 */
export async function lanInfo() {
  const localPage = isLocalPage();
  if (localPage) {
    try {
      const r = await fetch('/api/net', { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        const ip = data.ips?.[0] ?? currentHost();
        const port = data.port ?? DEFAULT_PORT;
        return { ...data, localPage, url: `http://${ip}:${port}/` };
      }
    } catch {
      /* 没有服务器 */
    }
  }
  // 静态托管：页面自己的地址（托管商一般不会转发 /ws，所以联机通常不可用，
  // 但至少给出的地址是真实存在的，而不是编出来的 :5173）
  return {
    ips: [currentHost()],
    port: Number(location.port) || (location.protocol === 'https:' ? 443 : 80),
    localPage,
    url: location.origin ? `${location.origin}/` : '',
  };
}

export class LanLink {
  /**
   * @param {object} opts
   * @param {'host'|'guest'} opts.role
   * @param {string} [opts.room] 客机需要房间号
   * @param {object} opts.handlers {onOpen,onMessage,onClose,onError}
   */
  constructor({ role, room, url, handlers = {} }) {
    this.role = role;
    this.room = room;
    this.handlers = handlers;
    this.ws = null;
    this.timer = null;
    this.url = url ?? this.buildUrl();
  }

  buildUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const host = this.role === 'host' ? location.host : this.urlHost ?? location.host;
    const q = new URLSearchParams({ role: this.role });
    if (this.room) q.set('room', this.room);
    return `${proto}://${host}/ws?${q}`;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.clearTimeout();
      this.handlers.onOpen?.();
    };
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handlers.onMessage?.(msg);
    };
    this.ws.onclose = () => {
      this.clearTimeout();
      this.handlers.onClose?.();
    };
    this.ws.onerror = () => {
      this.clearTimeout();
      this.handlers.onError?.(new Error('连接失败'));
    };
    return this;
  }

  /**
   * 连接超时。
   * 地址写错时浏览器可能既不触发 open 也不触发 error/close（例如
   * 拼成了非法主机名），没有这个计时器 UI 会永远停在"正在连接…"。
   */
  startTimeout(ms = CONNECT_TIMEOUT) {
    this.clearTimeout();
    this.timer = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) return;
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      this.handlers.onError?.(new Error('连接超时'));
    }, ms);
    return this;
  }

  clearTimeout() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  close() {
    this.clearTimeout();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

/** 默认连接超时（毫秒）：没有超时会让 UI 永远卡在"正在连接…" */
const CONNECT_TIMEOUT = 8000;

/**
 * 把用户粘贴的内容整理成 host[:port]。
 * 房主面板上显示的是 `http://192.168.1.5:5173/`，用户会直接整段粘过来，
 * 所以 http/https/ws/wss 前缀和结尾斜杠、路径都要剥掉。
 */
export function parseAddress(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  // 剥协议前缀
  s = s.replace(/^(https?|wss?):\/\//i, '');
  // 剥路径 / 查询 / 结尾斜杠
  s = s.split('/')[0].split('?')[0].trim();
  return s;
}

/**
 * 客机：支持直接填 "192.168.1.5"、"192.168.1.5:5173"，或整段粘
 * "http://192.168.1.5:5173/"。
 * @returns {LanLink}
 */
export function connectAsGuest(address, room, handlers) {
  const host = parseAddress(address);
  if (!host) throw new Error('请填写房主地址');
  const withPort = host.includes(':') ? host : `${host}:${location.port || DEFAULT_PORT}`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({ role: 'guest' });
  if (room) q.set('room', room);
  const link = new LanLink({
    role: 'guest',
    room,
    url: `${proto}://${withPort}/ws?${q}`,
    handlers,
  }).connect();
  link.startTimeout();
  return link;
}

export function connectAsHost(room, handlers) {
  const link = new LanLink({ role: 'host', room, handlers }).connect();
  link.startTimeout();
  return link;
}
