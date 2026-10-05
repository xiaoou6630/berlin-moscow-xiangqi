/**
 * 零依赖 WebSocket 服务端（RFC 6455 的最小子集）。
 *
 * 只实现我们需要的部分：文本帧、掩码解析、ping/pong、关闭。
 * 用于局域网对战：房主跑 server，客机用 ws://<房主IP>:<port>/ws 连进来。
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 把 HTTP 连接升级成 WebSocket */
export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  return new WSConnection(socket);
}

export class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    /** 附加数据：房间里用来存 { side } */
    this.meta = {};

    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        this._drain();
      } catch (err) {
        // 帧畸形（比如声明 9MB 的超长长度、非法掩码）不能把整个进程带崩：
        // 关掉这条连接，回一个 1009（消息过大）就够。
        this.close(1009, err?.message ?? 'bad frame');
      }
    });
    // upgrade 后的 socket 默认 allowHalfOpen=true：客户端发 FIN 时只会触发 end，
    // 可写端一直开着，close 永远不会来 —— 那样座位和房间都永久泄漏。
    socket.allowHalfOpen = false;
    socket.on('end', () => {
      try {
        socket.end();
      } catch {
        /* ignore */
      }
      this._closed();
    });
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  _drain() {
    // 一帧可能分片到达，凑够再解
    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.totalLength);

      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        this._send(frame.payload, 0xa); // pong
        continue;
      }
      if (frame.opcode === 0x1) {
        this.onmessage?.(frame.payload.toString('utf8'));
      }
      // 其余（二进制、pong）忽略
    }
  }

  send(text) {
    this._send(Buffer.from(text, 'utf8'), 0x1);
  }

  _send(payload, opcode) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._closed();
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    try {
      const r = Buffer.from(String(reason), 'utf8').subarray(0, 120);
      const payload = Buffer.alloc(2 + r.length);
      payload.writeUInt16BE(code, 0);
      r.copy(payload, 2);
      this._send(payload, 0x8);
      this.socket.end();
    } catch {
      /* ignore */
    }
    this._closed();
  }
}

/** 单帧上限：超过就断开，避免被一条长度字段撑爆内存 */
const MAX_FRAME = 1 << 20; // 1 MB，对局消息绰绰有余

/**
 * 解一帧。数据不够返回 null。
 * 客户端发来的帧必须带掩码。
 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    // 只用 14 字节就能声明一个 9MB 的帧；这里直接拒绝，
    // 由调用方捕获并关连接（不能 throw 到进程顶层）
    if (big > BigInt(MAX_FRAME)) throw new Error(`帧过大: ${big}`);
    len = Number(big);
    offset += 8;
  }
  if (len > MAX_FRAME) throw new Error(`帧过大: ${len}`);

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, totalLength: offset + len };
}
