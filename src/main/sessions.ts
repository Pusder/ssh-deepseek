import { app, MessageChannelMain, WebContents, ipcMain } from 'electron';
import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from './ipc';
import { getStore } from './store';
import { shouldMarkConnected } from './ssh-status';
import {
  SessionEndedEvent,
  SessionMeta,
  SessionStatus,
  SessionStatusEvent,
  SshConfig,
  TermSize,
} from './types';

/** node-pty 伪终端的最小接口（惰性加载原生模块，避免顶层依赖） */
interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
}

/** 单次 SSH 会话 */
interface Session {
  id: string;
  config: SshConfig;
  status: SessionStatus;
  startedAt: number;
  client: Client | null;
  /** 系统 ssh.exe 传输层的伪终端（transport=systemSsh 时使用） */
  term: PtyLike | null;
  stream: ClientChannel | null;
  /** 与渲染进程相连的消息端口（终端数据专用通道） */
  port: Electron.MessagePortMain | null;
  cols: number;
  rows: number;
  /** 用户主动断开 / 关闭标签 */
  closing: boolean;
  /** 已发送结束通知 */
  finished: boolean;
  /** 当前连接尝试序号，用于丢弃过期连接的回调 */
  attempt: number;
  /** 同一 tick 内待合并下发的数据块（每会话独立，避免多会话互相干扰） */
  pending: Uint8Array[];
  pendingBytes: number;
  flushScheduled: boolean;
  /** 拥有该会话的窗口，用于回传状态/结束事件 */
  owner: WebContents | null;
  /**
   * window-change 重试定时器。
   * 原因：服务端在 PTY 分配后才挂上 window-change 监听，存在极短的时间差；
   * 若用户「刚连上就拖动窗口」，这次的调整请求会被丢弃。这里在 Shell 打开后
   * 的短时间内做有限次重发，确保尺寸最终与服务端一致。一旦收到远端输出即停止。
   */
  resizeTimer: NodeJS.Timeout | null;
  /** Shell 通道是否已打开 */
  shellOpened: boolean;
  /** 待交付给渲染进程的通道对端端口（渲染进程就绪后取走） */
  peerPort: Electron.MessagePortMain | null;
}

/** 超过该字节数的输入立即下发，不再等待同一 tick 的后续拼接 */
const WRITE_COALESCE_LIMIT = 512 * 1024;

/**
 * SSH 会话管理器。
 *
 * 数据通路设计（性能关键）：
 *   渲染进程 xterm <--MessagePort(二进制 ArrayBuffer)--> 主进程 ssh2 stream
 * 不使用 ipcRenderer.on / webContents.send 传输终端数据，因为那条路径会经过
 * 结构化克隆 + V8 序列化，在大文件 cat / yes 这类高频输出下会成为瓶颈。
 * MessagePort 直接把 Buffer 以 ArrayBuffer 形式零拷贝投递，渲染层拿到
 * Uint8Array 后可原样交给 term.write()，无需 UTF-8 字符串解码。
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private channelCounter = 0;

  constructor() {
    /**
     * 渲染进程就绪后取走该会话的数据通道对端端口。
     * 主进程在 create() 时就已经持有可写的一端，这里是纯交付，不重建通道，
     * 因此不会出现任何数据丢失窗口。
     */
    ipcMain.on(IPC.sessionReady, (event, payload: { sessionId?: string }) => {
      const sessionId = String(payload?.sessionId ?? '');
      const s = this.sessions.get(sessionId);
      if (!s) {
        console.warn('[session] 渲染进程请求数据通道，但会话不存在', sessionId);
        return;
      }
      const peer = s.peerPort;
      if (!peer) {
        console.warn('[session] 会话没有可交付的端口', sessionId);
        return;
      }
      s.peerPort = null;
      s.owner = event.sender;
      try {
        event.sender.mainFrame.postMessage(IPC.sessionPort, { sessionId }, [peer]);
      } catch (err) {
        console.error('[session] 下发数据通道失败', err);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 对外 API                                                            */
  /* ------------------------------------------------------------------ */

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      configId: s.config.id,
      title: s.config.name,
      host: s.config.host,
      port: s.config.port,
      username: s.config.username,
      status: s.status,
      startedAt: s.startedAt,
    }));
  }

  /**
   * 创建会话：同步登记并立即返回，真正的 TCP 连接在后台进行。
   * 渲染进程拿到返回值后马上建立 MessagePort，因此不会漏掉任何早期输出。
   */
  create(configId: string, size: TermSize, sender: WebContents): { ok: boolean; sessionId?: string; error?: string } {
    const store = getStore();
    const config = store.getConfig(configId);
    if (!config) return { ok: false, error: '配置不存在或已被删除' };
    if (!config.host) return { ok: false, error: '主机地址为空' };

    const sessionId = `s${Date.now().toString(36)}-${++this.channelCounter}`;
    const session: Session = {
      id: sessionId,
      config,
      status: 'connecting',
      startedAt: Date.now(),
      client: null,
      term: null,
      stream: null,
      port: null,
      cols: clampInt(size?.cols, 2, 1000, 80),
      rows: clampInt(size?.rows, 1, 1000, 24),
      closing: false,
      finished: false,
      attempt: 0,
      pending: [],
      pendingBytes: 0,
      flushScheduled: false,
      owner: sender,
      resizeTimer: null,
      shellOpened: false,
      peerPort: null,
    };
    this.sessions.set(sessionId, session);
    // 显式广播初始状态：渲染层本地也会自设 connecting，但事件保持同源以免对不上
    this.setStatus(session, 'connecting');

    /**
     * 立即建立数据通道，并把「对端端口」暂存起来等渲染进程来取。
     *
     * 为什么这样设计：主进程从会话创建的第一毫秒起就持有可写端口，
     * 因此连接过程中的 banner、错误提示都不会因为「渲染进程还没绑定」而丢失；
     * 渲染进程稍后通过 IPC.sessionReady 取走对端端口，两端即可全双工通信。
     */
    const { port1, port2 } = new MessageChannelMain();
    this.attachPort(sessionId, port1, sender);
    session.peerPort = port2;

    // 后台连接，不阻塞 invoke 返回
    void this.connect(session);
    return { ok: true, sessionId };
  }

  write(sessionId: string, data: Uint8Array | string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.term) {
      // ConPTY 传输层：输入走伪终端
      try {
        s.term.write(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
      } catch (err) {
        console.error('[session] 写入伪终端失败', err);
      }
      return;
    }
    if (!s.stream || s.stream.destroyed) return;
    try {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      if (buf.length) s.stream.write(buf);
    } catch (err) {
      console.error('[session] 写入选端失败', err);
    }
  }

  resize(sessionId: string, size: TermSize): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.cols = clampInt(size?.cols, 2, 1000, s.cols);
    s.rows = clampInt(size?.rows, 1, 1000, s.rows);
    if (s.term) {
      // ConPTY 传输层：直接调整伪终端尺寸，由 ssh 通知远端
      try {
        s.term.resize(s.cols, s.rows);
      } catch (err) {
        console.warn('[session] pty resize 失败', err);
      }
      return;
    }
    this.applyWindowSize(s);
    // 重开一个重试窗口：万一服务端此刻还没挂上 window-change 监听，
    // 这次调整会在随后的重试中补发，不会丢失。
    if (s.shellOpened && !s.closing && !s.finished) this.startResizeRetry(s);
  }

  /** 关闭标签：结束会话并释放连接 */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.closing = true;
    this.teardown(s, '会话已关闭', true);
  }

  closeAll(): void {
    for (const s of [...this.sessions.values()]) {
      s.closing = true;
      this.teardown(s, '应用退出', true);
    }
  }

  /** 窗口销毁时清掉属于它的一切会话，避免连接泄漏 */
  closeByWebContents(wc: WebContents): void {
    for (const s of [...this.sessions.values()]) {
      if (s.owner === wc) {
        s.closing = true;
        this.teardown(s, '窗口已关闭', true);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 端口通道                                                            */
  /* ------------------------------------------------------------------ */

  private attachPort(sessionId: string, port: Electron.MessagePortMain, owner: WebContents): void {
    const s = this.sessions.get(sessionId);
    if (!s) {
      try {
        port.close();
      } catch {
        /* ignore */
      }
      return;
    }
    // 同一会话重新挂载端口（例如渲染进程重载）时，先摘掉旧端口
    if (s.port && s.port !== port) this.detachPort(s);

    s.port = port;
    s.owner = owner;

    port.on('message', (event: Electron.MessageEvent) => {
      const msg = event.data as { type?: string; data?: Uint8Array; size?: TermSize };
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'write':
          if (msg.data) this.write(sessionId, msg.data);
          break;
        case 'resize':
          if (msg.size) this.resize(sessionId, msg.size);
          break;
        case 'disconnect':
          s.closing = true;
          this.teardown(s, '已断开连接', true);
          break;
        default:
          break;
      }
    });

    port.on('close', () => {
      if (s.port === port) s.port = null;
    });

    // 回传引导信息，渲染进程据此渲染标题与初始状态
    this.postPort(s, {
      type: 'bootstrap',
      sessionId: s.id,
      config: {
        id: s.config.id,
        name: s.config.name,
        host: s.config.host,
        port: s.config.port,
        username: s.config.username,
      },
      status: s.status,
    });
  }

  private detachPort(s: Session): void {
    const port = s.port;
    s.port = null;
    if (!port) return;
    try {
      port.removeAllListeners();
      port.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * 向渲染进程发送端口消息。
   *
   * 注意：Electron 的 MessagePortMain 只支持转移 MessagePortMain，不支持 ArrayBuffer
   * 作为 transferable，因此这里直接把 Uint8Array 放进消息体（结构化克隆会复制字节），
   * 主进程侧的原始 Buffer 依然保留所有权，可安全复用。
   */
  private postPort(s: Session, message: unknown): void {
    const port = s.port;
    if (!port) return;
    try {
      port.postMessage(message);
    } catch (err) {
      // 端口在渲染进程销毁后写入会抛异常，直接摘除
      console.warn('[session] 端口写入失败，已摘除', err);
      s.port = null;
    }
  }

  /** 向终端写入一段文本（用于本地提示信息） */
  private notice(s: Session, text: string): void {
    this.postPort(s, { type: 'data', data: new Uint8Array(Buffer.from(text, 'utf8')) });
  }

  /** 批量下发远端数据，合并同一 tick 内的多个 chunk，减少 postMessage 次数 */
  private flushData(s: Session): void {
    s.flushScheduled = false;
    const chunks = s.pending;
    s.pending = [];
    s.pendingBytes = 0;

    // 收到远端输出 = Shell 通道已完全就绪，停止窗口尺寸重试
    if (chunks.length && s.resizeTimer) {
      clearInterval(s.resizeTimer);
      s.resizeTimer = null;
    }

    if (!chunks.length || !s.port) return;
    if (chunks.length === 1) {
      this.postPort(s, { type: 'data', data: chunks[0] });
      return;
    }
    // 合并为单个缓冲：一次跨进程序列化，比多次小消息更快
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    this.postPort(s, { type: 'data', data: merged });
  }

  private pushData(s: Session, chunk: Buffer): void {
    const view = new Uint8Array(chunk.byteLength);
    view.set(chunk);
    s.pending.push(view);
    s.pendingBytes += view.byteLength;
    if (s.pendingBytes >= WRITE_COALESCE_LIMIT) {
      this.flushData(s);
      return;
    }
    if (!s.flushScheduled) {
      s.flushScheduled = true;
      setImmediate(() => this.flushData(s));
    }
  }

  /* ------------------------------------------------------------------ */
  /* SSH 连接生命周期                                                    */
  /* ------------------------------------------------------------------ */

  private setStatus(s: Session, status: SessionStatus, message?: string): void {
    s.status = status;
    const payload: SessionStatusEvent = { sessionId: s.id, status, message };
    this.sendToOwner(s, IPC.sessionStatus, payload);
  }

  /** 向拥有该会话的窗口发送事件（窗口已销毁则静默丢弃） */
  private sendToOwner(s: Session, channel: string, payload: unknown): void {
    const wc = s.owner;
    if (!wc || wc.isDestroyed()) return;
    // 防御：owner 可能来自测试桩或被销毁的窗口，send 不可用时直接忽略
    if (typeof (wc as { send?: unknown }).send !== 'function') return;
    try {
      wc.send(channel, payload);
    } catch (err) {
      console.warn('[session] 事件发送失败', channel, err);
    }
  }

  private async connect(session: Session): Promise<void> {
    const s = session;
    s.attempt++;
    const attempt = s.attempt;
    const store = getStore();
    const cfg = s.config;

    this.notice(
      s,
      `\x1b[38;5;245m正在连接 ${cfg.username ? cfg.username + '@' : ''}${cfg.host}:${cfg.port} ...\x1b[0m\r\n`,
    );

    // 传输层选择：系统 ssh.exe（应对按进程放行内网连接的公司管控软件）
    if (store.getSettings().transport === 'systemSsh') {
      this.connectViaSshExe(s);
      return;
    }

    let config: ConnectConfig;
    try {
      config = await this.buildConnectConfig(cfg, s);
    } catch (err) {
      this.failEarly(s, errMessage(err));
      return;
    }

    const client = new Client();
    s.client = client;

    client.on('banner', (banner: string) => {
      if (banner?.trim()) this.notice(s, `\x1b[38;5;245m${banner.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
    });

    client.on('ready', () => {
      if (attempt !== s.attempt || s.closing) return;
      store.touchConfig(cfg.id);
      this.setStatus(s, 'connected');
      this.notice(s, `\x1b[32m● 已连接 ${cfg.host}:${cfg.port}\x1b[0m\r\n`);

      client.shell(
        {
          term: 'xterm-256color',
          cols: s.cols,
          rows: s.rows,
          width: 0,
          height: 0,
        },
        (err, stream) => {
          if (attempt !== s.attempt || s.closing) {
            try {
              stream?.close();
            } catch {
              /* ignore */
            }
            return;
          }
          if (err || !stream) {
            this.notice(s, `\x1b[31m✖ 无法打开远程 Shell：${errMessage(err)}\x1b[0m\r\n`);
            this.setStatus(s, 'error', errMessage(err));
            this.teardown(s, '无法打开远程 Shell', false);
            return;
          }
          s.stream = stream;
          s.shellOpened = true;
          this.applyWindowSize(s);
          this.startResizeRetry(s);

          stream.on('data', (chunk: Buffer) => {
            if (attempt !== s.attempt) return;
            this.pushData(s, chunk);
          });

          stream.stderr?.on('data', (chunk: Buffer) => {
            if (attempt !== s.attempt) return;
            this.pushData(s, chunk);
          });

          stream.on('close', () => {
            if (attempt !== s.attempt) return;
            this.teardown(s, s.closing ? '已断开连接' : '远程主机已关闭连接', s.closing);
          });

          stream.on('error', (streamErr: Error) => {
            if (attempt !== s.attempt) return;
            this.flushData(s);
            this.notice(s, `\x1b[31m✖ 会话错误：${errMessage(streamErr)}\x1b[0m\r\n`);
            this.teardown(s, errMessage(streamErr), false);
          });
        },
      );
    });

    client.on('error', (err: Error & { level?: string }) => {
      if (attempt !== s.attempt) return;
      const text = errMessage(err);
      this.flushData(s);
      this.notice(s, `\x1b[31m✖ 连接失败：${text}\x1b[0m\r\n`);
      this.setStatus(s, 'error', text);
      this.teardown(s, text, false);
    });

    client.on('close', () => {
      if (attempt !== s.attempt) return;
      this.teardown(s, s.closing ? '已断开连接' : '连接已被远端关闭', s.closing);
    });

    try {
      client.connect(config);
    } catch (err) {
      this.failEarly(s, errMessage(err));
    }
  }

  /** 构造 ssh2 连接参数（含私钥读取与主机密钥校验） */
  private async buildConnectConfig(cfg: SshConfig, s: Session): Promise<ConnectConfig> {
    const config: ConnectConfig = {
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username || undefined,
      readyTimeout: 25000,
      keepaliveInterval: 20000,
      keepaliveCountMax: 4,
      // 首次连接自动信任并记录指纹，之后指纹变化即拒绝连接
      hostVerifier: (key: Buffer) => {
        const fingerprint = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
        const store = getStore();
        const result = store.verifyHostKey(cfg.host, cfg.port || 22, fingerprint);
        if (!result.kept) {
          this.notice(
            s,
            `\x1b[31m✖ 主机密钥已变更！\x1b[0m\r\n` +
              `\x1b[33m  主机：${cfg.host}:${cfg.port}\x1b[0m\r\n` +
              `\x1b[33m  当前指纹：${fingerprint}\x1b[0m\r\n` +
              `\x1b[33m  已信任指纹：${store.listKnownHosts().find((k) => k.host === cfg.host && k.port === (cfg.port || 22))?.fingerprint ?? '(未知)'}\x1b[0m\r\n` +
              `\x1b[33m  如确认服务器已重装，请在“设置 - 已信任主机”中删除该记录后重试。\x1b[0m\r\n`,
          );
          return false;
        }
        if (result.firstTime) {
          this.notice(s, `\x1b[38;5;245m首次连接，已记录主机指纹 ${fingerprint}\x1b[0m\r\n`);
        }
        return true;
      },
      algorithms: {
        // 兼容老旧服务器：保留 ssh-rsa / diffie-hellman-group14-sha1 等常见算法
        kex: [
          'curve25519-sha256',
          'curve25519-sha256@libssh.org',
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group-exchange-sha256',
          'diffie-hellman-group16-sha512',
          'diffie-hellman-group18-sha512',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
          'diffie-hellman-group-exchange-sha1',
          'diffie-hellman-group1-sha1',
        ],
      },
    };

    // 私钥认证优先于密码认证
    if (cfg.privateKeyPath) {
      const keyPath = path.resolve(cfg.privateKeyPath.replace(/^"|"$/g, ''));
      if (!fs.existsSync(keyPath)) {
        throw new Error(`私钥文件不存在：${keyPath}`);
      }
      const ext = path.extname(keyPath).toLowerCase();
      if (ext === '.ppk') {
        throw new Error('不支持 PuTTY 的 .ppk 私钥，请先用 PuTTYgen 转换为 OpenSSH 格式（.pem/.key）');
      }
      const content = fs.readFileSync(keyPath);
      if (content.includes(Buffer.from('BEGIN RSA PRIVATE KEY')) && content.length === 0) {
        throw new Error('私钥文件为空');
      }
      config.privateKey = content;
      if (cfg.passphrase) config.passphrase = cfg.passphrase;
    }

    if (cfg.password) config.password = cfg.password;
    if (!config.privateKey && !config.password) {
      throw new Error('未提供密码或私钥，无法认证');
    }
    return config;
  }

  /* ------------------------------------------------------------------ */
  /* 系统 ssh.exe 传输层                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * 为什么存在这一层：部分公司管控软件按「发起连接的进程」放行内网访问，
   * 内置 ssh2 库跑在未签名的 Electron 进程里，连接可能在 SSH 版本交换前
   * 就被掐断；而 Windows 自带的 ssh.exe（微软签名）通常被放行。
   *
   * 本传输层在 ConPTY 伪终端里运行系统 ssh.exe，与用户手动在 PowerShell
   * 敲 ssh 的形态完全一致：认证提示直接出现在终端里，由传输层识别提示
   * 后自动填入密码/口令；窗口尺寸变更经伪终端实时同步给远端。
   *
   * 已知限制：
   * - 主机指纹由 OpenSSH 自己的 known_hosts 管理（首次连接自动信任），
   *   与内置传输层的指纹库相互独立；
   * - 依赖 Windows 10 1809+ 自带的 OpenSSH 客户端。
   */
  private connectViaSshExe(s: Session): void {
    const cfg = s.config;

    const sshExe = resolveSshExe();
    if (!sshExe) {
      this.failEarly(s, '未找到系统 ssh.exe（需要 Windows 10 1809+ 自带的 OpenSSH 客户端）');
      return;
    }

    let args: string[];
    try {
      args = buildSshExeArgs(cfg);
    } catch (err) {
      this.failEarly(s, errMessage(err));
      return;
    }

    this.notice(s, '\x1b[38;5;245m（传输层：系统 ssh.exe）\x1b[0m\r\n');

    // 惰性加载原生模块：仅 systemSsh 传输层需要，加载失败不影响内置 ssh2 传输层
    let ptySpawn: (file: string, args: string[], options: Record<string, unknown>) => PtyLike;
    try {
      ptySpawn = (require('@homebridge/node-pty-prebuilt-multiarch') as {
        spawn: typeof ptySpawn;
      }).spawn;
    } catch (err) {
      this.failEarly(s, `加载 node-pty 失败：${errMessage(err)}`);
      return;
    }

    let term: PtyLike;
    try {
      term = ptySpawn(sshExe, args, {
        name: 'xterm-256color',
        cols: s.cols,
        rows: s.rows,
        env: { ...process.env } as Record<string, string>,
      });
    } catch (err) {
      this.failEarly(s, `无法启动系统 ssh.exe：${errMessage(err)}`);
      return;
    }
    s.term = term;

    let gotOutput = false;
    let authPromptSeen = false;
    let passwordSent = false;
    let passphraseSent = false;
    // 保留输出尾部用于识别认证提示（提示可能与前一段输出分片到达）
    let tail = '';

    const markConnected = (): void => {
      if (s.finished || s.closing || s.status !== 'connecting') return;
      this.setStatus(s, 'connected');
      this.notice(s, `\x1b[32m● 已连接 ${cfg.host}:${cfg.port}\x1b[0m\r\n`);
    };

    const watchdog = setTimeout(() => {
      if (!gotOutput && !s.finished && !s.closing) {
        this.failEarly(s, '连接超时：系统 ssh.exe 25 秒内无任何响应');
      }
    }, 25000);

    term.onData((data: string) => {
      if (!gotOutput) {
        gotOutput = true;
        clearTimeout(watchdog);
        /**
         * 兜底计时：认证提示的形态千差万别（自定义键盘交互文案、配置了私钥
         * 口令但服务端未启用等），提示识别一旦失手，上面的事件判定会让状态
         * 永久卡在「连接中」——用户终端里都能敲命令了界面却还在转黄。
         * 因此首段输出后 5 秒仍处于 connecting 就强制视为已连接；
         * 若 5 秒内正常认证完成，markConnected 的状态守卫会让这里变成空操作。
         */
        setTimeout(markConnected, 5000);
      }
      tail = (tail + data).slice(-160);

      // 认证失败：终止会话
      if (/permission denied/i.test(data)) {
        this.failEarly(s, '认证失败：用户名或密码不正确（系统 ssh.exe 返回 Permission denied）');
        return;
      }

      // 认证提示出现时自动填入（各自仅一次，避免重复提交）
      if (!passwordSent && !cfg.privateKeyPath && cfg.password && /password[:：]?\s*$/i.test(tail)) {
        authPromptSeen = true;
        passwordSent = true;
        term.write(cfg.password + '\r');
      } else if (
        !passphraseSent &&
        cfg.privateKeyPath &&
        cfg.passphrase &&
        /passphrase[:：]?\s*$/i.test(tail)
      ) {
        authPromptSeen = true;
        passphraseSent = true;
        term.write(cfg.passphrase + '\r');
      }

      /**
       * 连接成功判定：收到「非认证提示」输出时按规则翻转。
       * 不能像最早那样在第一段输出就翻状态——那通常就是 password 提示，
       * 认证并未完成，会造成「页签还在闪黄、状态却已变绿」的错乱；
       * 但识别失手时也不能卡死，上面的 5 秒兜底负责最终收敛。
       */
      if (s.status === 'connecting') {
        const atAuthPrompt = /password[:：]?\s*$/i.test(tail) || /passphrase[:：]?\s*$/i.test(tail);
        if (
          shouldMarkConnected({
            authPromptSeen,
            passwordSent,
            passphraseSent,
            hasPassword: !!cfg.password,
            hasPrivateKey: !!cfg.privateKeyPath,
            hasPassphrase: !!cfg.passphrase,
            tailEndsWithAuthPrompt: atAuthPrompt,
          })
        ) {
          markConnected();
        }
      }

      this.pushData(s, Buffer.from(data, 'utf8'));
    });

    term.onExit(({ exitCode }) => {
      clearTimeout(watchdog);
      this.teardown(
        s,
        s.closing ? '已断开连接' : `远程会话已结束（退出码 ${exitCode ?? '未知'}）`,
        s.closing,
      );
    });
  }

  private failEarly(s: Session, message: string): void {
    // 幂等：仅在连接期生效一次。否则看门狗与认证失败同时触发时会发出两遍 error 事件
    if (s.status !== 'connecting') return;
    this.notice(s, `\x1b[31m✖ 连接失败：${message}\x1b[0m\r\n`);
    this.setStatus(s, 'error', message);
    this.teardown(s, message, false);
  }

  private applyWindowSize(s: Session): void {
    if (!s.stream || s.stream.destroyed) return;
    try {
      // 顺序固定为 (rows, cols, height, width)，与 ssh2 文档一致
      s.stream.setWindow(s.rows, s.cols, 0, 0);
    } catch (err) {
      console.warn('[session] setWindow 失败', err);
    }
  }

  /**
   * Shell 打开后的一小段时间内重发窗口尺寸。
   * 覆盖「刚连接就拖动窗口」的竞态：此时服务端的 window-change 监听可能还没就绪。
   * 一旦收到远端输出（说明通道真正可用）即停止，因此最多只多发几次。
   */
  private startResizeRetry(s: Session): void {
    this.stopResizeRetry(s);
    let attempts = 0;
    s.resizeTimer = setInterval(() => {
      attempts++;
      if (s.finished || s.closing || !s.stream || s.stream.destroyed || attempts > 6) {
        this.stopResizeRetry(s);
        return;
      }
      this.applyWindowSize(s);
    }, 150);
  }

  private stopResizeRetry(s: Session): void {
    if (s.resizeTimer) {
      clearInterval(s.resizeTimer);
      s.resizeTimer = null;
    }
  }

  /**
   * 结束会话：先冲掉缓冲数据，再发结束通知，最后释放资源。
   * 幂等 —— 多处事件可能同时触发。
   */
  private teardown(s: Session, reason: string, clean: boolean): void {
    if (s.finished) return;
    s.finished = true;
    s.attempt++;
    this.stopResizeRetry(s);
    this.flushData(s);

    // 已经是错误状态时保留错误原因，不要被“已断开”覆盖
    if (s.status !== 'error') this.setStatus(s, 'disconnected', reason);

    const ended: SessionEndedEvent = { sessionId: s.id, reason, clean };
    this.sendToOwner(s, IPC.sessionEnded, ended);

    try {
      s.stream?.end();
      s.stream?.destroy();
    } catch {
      /* ignore */
    }
    try {
      s.client?.end();
      s.client?.destroy();
    } catch {
      /* ignore */
    }
    s.stream = null;
    s.client = null;

    try {
      s.term?.kill();
    } catch {
      /* ignore */
    }
    s.term = null;

    // 延迟释放端口，确保上面排队的消息已经送达渲染进程
    const port = s.port;
    const sessionId = s.id;
    setTimeout(() => {
      if (port && s.port === port) this.detachPort(s);
      this.sessions.delete(sessionId);
      s.owner = null;
    }, 300);
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ---------------------------------------------------------------------- */
/* 系统 ssh.exe 传输层辅助                                                  */
/* ---------------------------------------------------------------------- */

/** 系统 OpenSSH 客户端：只认 System32 自带的（PATH 上的 Git 等第三方 ssh 管控表现不一致） */
function resolveSshExe(): string | null {
  const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  return fs.existsSync(system) ? system : null;
}

/** 组装系统 ssh.exe 命令行参数。运行在真实伪终端里，认证提示由传输层自动应答 */
function buildSshExeArgs(cfg: SshConfig): string[] {
  const args: string[] = [
    '-p', String(cfg.port || 22),
    // 首次连接自动信任并写入 known_hosts，之后由 OpenSSH 自行校验指纹
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join(app.getPath('userData'), 'known_hosts')}`,
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=4',
  ];

  const keyPath = cfg.privateKeyPath ? path.resolve(cfg.privateKeyPath.replace(/^"|"$/g, '')) : '';
  if (keyPath) {
    if (!fs.existsSync(keyPath)) {
      throw new Error(`私钥文件不存在：${keyPath}`);
    }
    if (path.extname(keyPath).toLowerCase() === '.ppk') {
      throw new Error('不支持 PuTTY 的 .ppk 私钥，请先用 PuTTYgen 转换为 OpenSSH 格式（.pem/.key）');
    }
    args.push('-i', keyPath, '-o', 'IdentitiesOnly=yes');
  } else if (!cfg.password) {
    throw new Error('未提供密码或私钥，无法认证');
  }

  args.push('-l', cfg.username, cfg.host);
  return args;
}

/** 把 Node/ssh2 的错误翻译成中文可读信息 */
export function errMessage(err: unknown): string {
  if (!err) return '未知错误';
  const e = err as NodeJS.ErrnoException & { level?: string };
  const code = e.code ?? '';
  const raw = e.message ?? String(err);
  switch (code) {
    case 'ECONNREFUSED':
      return '目标主机拒绝连接（端口未开放或服务未启动）';
    case 'ETIMEDOUT':
      return '连接超时，请检查网络与防火墙';
    case 'EHOSTUNREACH':
      return '主机不可达，请检查网络';
    case 'ENETUNREACH':
      return '网络不可达';
    case 'ENOTFOUND':
      return '域名解析失败，请检查主机地址';
    case 'ECONNRESET':
      return '连接被重置（可能被防火墙拦截或服务器主动断开）';
    case 'EPIPE':
      return '连接已断开';
    default:
      break;
  }
  if (/All configured authentication methods failed/i.test(raw)) {
    return '认证失败：用户名、密码或私钥不正确';
  }
  if (/Cannot parse privateKey|bad decrypt|Encrypted private key/i.test(raw)) {
    return '私钥解析失败：格式不受支持或私钥口令错误';
  }
  if (/Handshake failed|no matching (key exchange|host key|cipher)/i.test(raw)) {
    return `握手失败，算法不兼容：${raw}`;
  }
  if (/Timed out while waiting for handshake/i.test(raw)) {
    return '握手超时，服务器可能不是 SSH 服务或响应过慢';
  }
  if (e.level === 'client-authentication') return `认证失败：${raw}`;
  return raw;
}
