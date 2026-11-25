import { spawn } from "node:child_process";
import crypto from "node:crypto";
import EventEmitter from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable } from "./agent.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const bridgeScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "pty-bridge.py");
const MAX_SCROLLBACK_BYTES = 160 * 1024;

export function encodeWsFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

export class SimpleWebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._cleanup());
    socket.on("error", () => this._cleanup());
  }

  sendText(text) {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeWsFrame(text, 0x1));
    } catch {}
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeWsFrame(Buffer.alloc(0), 0x8));
      this.socket.end();
    } catch {}
    this.emit("close");
  }

  _cleanup() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buf.length < 4) return;
        payloadLen = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buf.length < 10) return;
        payloadLen = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }

      const maskBytes = masked ? 4 : 0;
      if (this.buf.length < offset + maskBytes + payloadLen) return;

      let maskKey = null;
      if (masked) {
        maskKey = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(this.buf.subarray(offset, offset + payloadLen));
      this.buf = this.buf.subarray(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        // Ping -> Pong
        try { this.socket.write(encodeWsFrame(payload, 0xA)); } catch {}
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        this.emit("message", payload.toString("utf8"));
      }
    }
  }
}

export function acceptWebSocket(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const ws = new SimpleWebSocket(socket);
  if (head && head.length > 0) ws._onData(head);
  return ws;
}

export class TerminalManager {
  constructor(defaultCwd = process.cwd()) {
    this.defaultCwd = defaultCwd;
    this.sessions = new Map();
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => this._summary(s));
  }

  create({ session = "", cols = 100, rows = 30 } = {}) {
    const pyExe = findExecutable("python3") || "/usr/bin/python3";
    const colabExe = findExecutable("colab");
    if (!colabExe) {
      return { ok: false, error: "未找到 colab 命令（请先安装 google-colab-cli）" };
    }
    const cleanSession = String(session || "").trim();
    if (!cleanSession) {
      return { ok: false, error: "请先连接一个运行中的 Colab 会话" };
    }
    const cmdArgs = [colabExe, "ssh", "-s", cleanSession];
    const title = `colab: ${cleanSession}`;
    const cwd = this.defaultCwd;

    const id = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const child = spawn(pyExe, [bridgeScript, ...cmdArgs], {
      cwd,
      env: {
        ...process.env,
        COLAB_DESK_COLS: String(Math.max(20, Number(cols) || 100)),
        COLAB_DESK_ROWS: String(Math.max(8, Number(rows) || 30)),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rec = {
      id,
      target: "colab",
      session: cleanSession,
      title,
      alive: true,
      exitCode: null,
      createdAt: Date.now(),
      child,
      clients: new Set(),
      scrollback: [],
      scrollbackBytes: 0,
      stdoutBuf: "",
    };
    this.sessions.set(id, rec);

    const pushOutput = (b64Data) => {
      const buf = Buffer.from(b64Data, "base64");
      rec.scrollback.push(buf);
      rec.scrollbackBytes += buf.length;
      while (rec.scrollbackBytes > MAX_SCROLLBACK_BYTES && rec.scrollback.length > 1) {
        const dropped = rec.scrollback.shift();
        rec.scrollbackBytes -= dropped.length;
      }
      const frame = JSON.stringify({ t: "o", d: b64Data });
      for (const ws of rec.clients) ws.sendText(frame);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      rec.stdoutBuf += chunk;
      const lines = rec.stdoutBuf.split("\n");
      rec.stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.t === "o" && typeof msg.d === "string") {
          pushOutput(msg.d);
        } else if (msg.t === "x") {
          rec.alive = false;
          rec.exitCode = msg.code ?? 0;
          const frame = JSON.stringify({ t: "x", code: rec.exitCode });
          for (const ws of rec.clients) ws.sendText(frame);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (!chunk) return;
      pushOutput(Buffer.from(chunk, "utf8").toString("base64"));
    });

    child.on("close", (code) => {
      if (rec.alive) {
        rec.alive = false;
        rec.exitCode = code ?? 0;
        const frame = JSON.stringify({ t: "x", code: rec.exitCode });
        for (const ws of rec.clients) ws.sendText(frame);
      }
    });

    return { ok: true, terminal: this._summary(rec) };
  }

  handleUpgrade(req, socket, head, id) {
    const rec = this.sessions.get(id);
    if (!rec) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;

    rec.clients.add(ws);
    if (rec.scrollback.length > 0) {
      const merged = Buffer.concat(rec.scrollback).toString("base64");
      ws.sendText(JSON.stringify({ t: "o", d: merged }));
    }
    if (!rec.alive) {
      ws.sendText(JSON.stringify({ t: "x", code: rec.exitCode ?? 0 }));
    }

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!rec.alive || !rec.child || !rec.child.stdin.writable) return;
      if (msg.t === "i" && typeof msg.d === "string") {
        try {
          rec.child.stdin.write(JSON.stringify({ t: "i", d: msg.d }) + "\n");
        } catch {}
      } else if (msg.t === "r") {
        try {
          rec.child.stdin.write(JSON.stringify({ t: "r", c: Number(msg.c) || 100, r: Number(msg.r) || 30 }) + "\n");
        } catch {}
      }
    });

    ws.on("close", () => {
      rec.clients.delete(ws);
    });
  }

  close(id) {
    const rec = this.sessions.get(id);
    if (!rec) return false;
    this.sessions.delete(id);
    rec.alive = false;
    for (const ws of rec.clients) ws.close();
    rec.clients.clear();
    try { rec.child.stdin.end(); } catch {}
    try { rec.child.kill("SIGTERM"); } catch {}
    return true;
  }

  shutdown() {
    for (const id of Array.from(this.sessions.keys())) {
      this.close(id);
    }
  }

  _summary(rec) {
    return {
      id: rec.id,
      target: rec.target,
      session: rec.session,
      title: rec.title,
      alive: rec.alive,
      exitCode: rec.exitCode,
      createdAt: rec.createdAt,
    };
  }
}
