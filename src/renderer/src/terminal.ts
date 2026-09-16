import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import type { AppSettings, SessionEndedEvent, SessionMeta, SessionStatus, SshConfig, TermSize } from '../../main/types';
import type { SessionChannel } from './api';
import { api } from './api';
import { getTheme } from './themes';
import { copyText, el, quoteRemotePath, readClipboard, uid } from './util';

export interface TerminalTabCallbacks {
  /** 状态变化，用于更新标签徽标 / 状态栏 */
  onStatus(tab: TerminalTab, status: SessionStatus, message?: string): void;
  /** 终端输出到达（用于未读提示） */
  onOutput(tab: TerminalTab): void;
  /** 终端标题（OSC 0/2）变化 */
  onTitle(tab: TerminalTab, title: string): void;
  /** 用户请求关闭标签（例如在终端里输入 exit 后关闭） */
  onCloseRequested(tab: TerminalTab): void;
  /** 查找栏开关，供容器调整布局 */
  onSearchToggle(tab: TerminalTab, open: boolean): void;
}

/** 端口消息协议（与主进程 PortIncomingMessage 对应） */
interface BootstrapMessage {
  type: 'bootstrap';
  sessionId: string;
  status: SessionStatus;
  config: { id: string; name: string; host: string; port: number; username: string };
}
interface DataMessage {
  type: 'data';
  data: Uint8Array;
}

/** 一条挂起中的远端探测（工具面板获取 cwd / 列目录用） */
interface ProbeWaiter {
  beginMarker: string;
  endMarker: string;
  /** 是否已见到起始标记（之后的内容才算结果） */
  started: boolean;
  buffer: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: number;
}

/**
 * 单个终端标签：持有 xterm 实例、WebGL 渲染器与一条 SSH 会话。
 *
 * 性能相关要点：
 * 1. 远端数据以 Uint8Array 直接交给 term.write()，不做解码/拼接/延迟；
 *    解码工作交给 xterm 内部增量 UTF-8 解码器，且享受其自带的写缓冲与背压合并。
 * 2. 窗口尺寸变化走「rAF 合并 -> fit() -> onResize -> 端口 resize」链路，
 *    resize 结束后重建 WebGL 渲染器，彻底消除拖拽缩放后的残留字符。
 * 3. 隐藏标签页暂停渲染（IntersectionObserver），避免多标签同时刷新抢占 GPU。
 */
export class TerminalTab {
  readonly id: string;
  readonly pane: HTMLElement;
  readonly term: Terminal;

  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private webgl: WebglAddon | null = null;
  private canvas: CanvasAddon | null = null;
  private rendererKind: 'webgl' | 'canvas' | 'dom' = 'dom';
  private webglRebuilds = 0;
  private disposed = false;

  private channel: SessionChannel | null = null;
  private sessionId: string | null = null;
  private status: SessionStatus = 'idle' as SessionStatus;
  private closing = false;

  private resizeObserver: ResizeObserver | null = null;
  private rafHandle = 0;
  private webglTimer: number | null = null;
  private resizeSettleTimer: number | null = null;

  private searchBar: HTMLElement;
  private searchInput: HTMLInputElement;
  private searchCount: HTMLElement;
  private searchOpen = false;

  /** 端口数据统计（用于性能观测与自动化测试断言） */
  private receivedFrames = 0;
  private receivedBytes = 0;
  /** 已发往远端的输入字节数（用于确认输入链路是否真的发出去了） */
  private sentInputBytes = 0;
  /** 最近一次发出的原始输入文本（诊断用） */
  private lastSent = '';

  /** 首次收到的终端尺寸由主进程在 createSession 时使用，这里保存最近一次 */
  private lastSize: TermSize = { cols: 80, rows: 24 };

  /** 挂起中的远端探测（工具面板用），输出到达时旁路匹配标记 */
  private probes: ProbeWaiter[] = [];
  private probeCounter = 0;
  private probeDecoder = new TextDecoder('utf8');

  /** 连接初期的状态对账轮询（详见 startStatusPolling） */
  private reconcileTimer: number | null = null;

  constructor(
    public config: SshConfig,
    private settings: AppSettings,
    private callbacks: TerminalTabCallbacks,
  ) {
    this.id = uid('tab');
    this.pane = el('div', { className: 'term-pane' });
    this.pane.dataset.tabId = this.id;

    const host = el('div', { className: 'xterm-host' });
    this.pane.appendChild(host);

    /* ------------------------- 查找工具条 ------------------------- */
    this.searchInput = el('input', {
      attrs: { type: 'text', placeholder: '查找内容…', spellcheck: 'false' },
    });
    this.searchCount = el('span', { className: 'search-count', text: '' });
    const prevBtn = el('button', { className: 'btn btn-ghost btn-sm', text: '上一个', title: '上一个 (Shift+Enter)' });
    const nextBtn = el('button', { className: 'btn btn-ghost btn-sm', text: '下一个', title: '下一个 (Enter)' });
    const closeBtn = el('button', { className: 'btn btn-ghost btn-sm', text: '✕', title: '关闭 (Esc)' });
    this.searchBar = el('div', {
      className: 'search-bar',
      children: [this.searchInput, this.searchCount, prevBtn, nextBtn, closeBtn],
    });
    this.pane.appendChild(this.searchBar);

    /* --------------------------- xterm --------------------------- */
    this.term = new Terminal({
      // 性能与体验参数
      scrollback: settings.scrollback,
      smoothScrollDuration: 0, // 平滑滚动会让高频输出产生视觉拖影，关闭
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 6,
      convertEol: false, // 远端 PTY 已输出 CRLF，禁止自行转换
      allowProposedApi: true,
      allowTransparency: false, // 关闭透明通道是 WebGL 性能与清晰度的关键
      altClickMovesCursor: false,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      cursorInactiveStyle: 'outline',
      drawBoldTextInBrightColors: true,
      scrollOnUserInput: true,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      letterSpacing: 0,
      fontWeight: '400',
      fontWeightBold: '700',
      minimumContrastRatio: 1,
      theme: getTheme(settings.theme).terminal,
      tabStopWidth: 8,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);

    // 在 pane 已插入 DOM 后再 open（构造时是分离节点，由容器负责先 append 再 open）
    this.term.open(host);
    this.attachRenderer();

    /* ------------------------- 终端事件 ------------------------- */
    // 输入直送 SSH 通道：不做任何缓冲或改写
    this.term.onData((data) => this.sendWrite(data));

    // fit() 之后 xterm 会触发 onResize，这里同步通知远端 PTY
    this.term.onResize(({ cols, rows }) => {
      this.lastSize = { cols, rows };
      this.pane.dataset.cols = String(cols);
      this.pane.dataset.rows = String(rows);
      this.sendResize(cols, rows);
    });

    this.term.onTitleChange((title) => {
      if (title?.trim()) this.callbacks.onTitle(this, title.trim());
    });

    // Ctrl+Shift+C / Ctrl+Shift+V / Ctrl+Shift+F，其余按键全部交给远端
    this.term.attachCustomKeyEventHandler((event) => this.handleKeyEvent(event));

    // xterm 5.5 移除了内置 linkHandler，改用 linkProvider 实现点击打开链接
    this.term.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const line = this.term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links: Array<{
          range: { start: { x: number; y: number }; end: { x: number; y: number } };
          text: string;
          activate: () => void;
        }> = [];
        const pattern = /https?:\/\/[^\s"'<>)\]]+/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          const start = match.index;
          const end = start + match[0].length - 1;
          // xterm 坐标从 1 开始
          links.push({
            range: { start: { x: start + 1, y: bufferLineNumber }, end: { x: end + 1, y: bufferLineNumber } },
            text: match[0],
            activate: () => {
              void api.openExternal(match![0]);
            },
          });
        }
        callback(links.length ? links : undefined);
      },
    });

    /* --------------------- 查找工具条交互 --------------------- */
    const runSearch = (direction: 'next' | 'prev') => this.doSearch(direction);
    this.searchInput.addEventListener('input', () => this.doSearch('next'));
    this.searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        runSearch(e.shiftKey ? 'prev' : 'next');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.toggleSearch(false);
        this.focus();
      }
    });
    prevBtn.addEventListener('click', () => runSearch('prev'));
    nextBtn.addEventListener('click', () => runSearch('next'));
    closeBtn.addEventListener('click', () => {
      this.toggleSearch(false);
      this.focus();
    });

    /* --------------------- 尺寸观察（核心） -------------------- */
    this.observeResize(host);
  }

  /* ================================================================== */
  /* 公共访问器                                                          */
  /* ================================================================== */

  get session(): string | null {
    return this.sessionId;
  }

  get currentStatus(): SessionStatus {
    return this.status;
  }

  get rendererName(): string {
    return this.rendererKind === 'webgl' ? 'WebGL' : this.rendererKind === 'canvas' ? 'Canvas' : 'DOM';
  }

  get size(): TermSize {
    return this.lastSize;
  }

  /** 收到多少帧 / 多少字节的远端数据（观测与测试用） */
  get stats(): { frames: number; bytes: number } {
    return { frames: this.receivedFrames, bytes: this.receivedBytes };
  }

  /** 已发往远端的输入字节数 */
  get sentBytes(): number {
    return this.sentInputBytes;
  }

  /** 最近一次实际发出的输入内容（诊断用） */
  get lastSentText(): string {
    return this.lastSent;
  }

  /** 数据通道收发计数（来自 preload 侧，用于区分「没发出去」和「没收到」） */
  get channelStats(): { sent: number; received: number } {
    return this.channel?.getStats?.() ?? { sent: 0, received: 0 };
  }

  /** 数据通道是否已建立 */
  get channelAlive(): boolean {
    return !!this.channel;
  }

  /** 直接经通道发送原始消息（诊断用，绕过所有业务逻辑） */
  postRaw(message: unknown): void {
    this.channel?.post(message);
  }

  get displayName(): string {
    return this.config.name || `${this.config.username}@${this.config.host}`;
  }

  /* ================================================================== */
  /* 会话生命周期                                                        */
  /* ================================================================== */

  /** 首次连接 */
  async connect(): Promise<void> {
    return this.openSession();
  }

  /** 重连：先清掉旧通道，再建立新会话 */
  async reconnect(): Promise<void> {
    this.teardownChannel();
    this.term.reset();
    this.webglRebuilds = 0;
    await this.openSession();
  }

  private async openSession(): Promise<void> {
    if (this.disposed) return;
    this.closing = false;
    this.setStatus('connecting', '正在连接…');
    this.writeNotice(`\x1b[38;5;245m正在连接 ${this.config.username ? this.config.username + '@' : ''}${this.config.host}:${this.config.port} …\x1b[0m\r\n`);

    try {
      const result = await api.createSession(this.config.id, this.lastSize);
      if (this.disposed) {
        if (result.sessionId) void api.closeSession(result.sessionId);
        return;
      }
      if (!result.ok || !result.sessionId) {
        this.setStatus('error', result.error ?? '无法创建会话');
        this.writeError(`✖ 连接失败：${result.error ?? '无法创建会话'}`);
        return;
      }

      const sessionId = result.sessionId;
      // 立刻登记 sessionId：主进程的状态/结束事件可能在 bootstrap 到达之前就已发出，
      // 只有先设置好 id，渲染层才能把这些事件对号入座（例如瞬时连接失败的情形）。
      this.sessionId = sessionId;

      // 建立二进制数据通道
      this.channel = api.createSessionChannel(sessionId, (raw) => this.onPortMessage(raw));

      // 连接初期对主进程做短轮询对账（见 startStatusPolling）
      this.startStatusPolling();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus('error', message);
      this.writeError(`✖ 连接失败：${message}`);
    }
  }

  /** 用户点击“断开” */
  async disconnect(): Promise<void> {
    if (!this.sessionId) return;
    this.closing = true;
    this.writeNotice('\r\n\x1b[38;5;245m正在断开连接…\x1b[0m\r\n');
    try {
      this.channel?.post({ type: 'disconnect' });
    } catch {
      /* ignore */
    }
    try {
      await api.closeSession(this.sessionId);
    } catch {
      /* ignore */
    }
  }

  /** 收到主进程的会话结束事件 */
  handleEnded(event: SessionEndedEvent): void {
    this.setStatus(event.clean ? 'disconnected' : 'error', event.reason);
    if (event.clean) {
      this.writeNotice(`\r\n\x1b[33m● 已断开：${event.reason}\x1b[0m\r\n`);
    }
    // 断开后保留标签，用户可随时重连
    this.teardownChannel();
  }

  handleStatus(status: SessionStatus, message?: string): void {
    this.setStatus(status, message);
  }

  /**
   * 连接初期对主进程做短轮询对账。
   *
   * 状态事件万一因时序问题丢失（例如事件先于 sessionId 登记到达而被丢弃），
   * 单靠事件流状态就会永久卡在「连接中」——即便主进程早已翻转。这里每 2 秒
   * 以主进程的权威状态纠偏一次，进入稳定态（connected / 断开 / 错误）即停止。
   */
  private startStatusPolling(): void {
    this.stopStatusPolling();
    let tries = 0;
    this.reconcileTimer = window.setInterval(() => {
      tries++;
      if (this.disposed || !this.sessionId || tries > 20) {
        this.stopStatusPolling();
        return;
      }
      void api
        .listSessions()
        .then((list) => {
          const meta = list.find((m) => m.sessionId === this.sessionId);
          if (!meta) {
            this.stopStatusPolling();
            return;
          }
          if (meta.status !== this.status) this.setStatus(meta.status);
          if (meta.status !== 'connecting') this.stopStatusPolling();
        })
        .catch(() => {
          /* 单次失败忽略，下个周期重试 */
        });
    }, 2000);
  }

  private stopStatusPolling(): void {
    if (this.reconcileTimer !== null) {
      window.clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /** 彻底销毁：关闭通道、释放 xterm 与渲染器 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    if (this.webglTimer) window.clearTimeout(this.webglTimer);
    if (this.resizeSettleTimer) window.clearTimeout(this.resizeSettleTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.teardownChannel();

    try {
      this.webgl?.dispose();
    } catch {
      /* ignore */
    }
    this.webgl = null;
    try {
      this.canvas?.dispose();
    } catch {
      /* ignore */
    }
    this.canvas = null;

    try {
      this.term.dispose();
    } catch {
      /* ignore */
    }
    this.pane.remove();
  }

  private teardownChannel(): void {
    const channel = this.channel;
    this.channel = null;
    this.sessionId = null;
    this.stopStatusPolling();
    // 挂起中的探测随之作废
    for (const waiter of this.probes) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('会话已断开，探测取消'));
    }
    this.probes = [];
    if (!channel) return;
    try {
      channel.close();
    } catch {
      /* ignore */
    }
  }

  /* ================================================================== */
  /* 端口数据                                                            */
  /* ================================================================== */

  private onPortMessage(raw: unknown): void {
    if (this.disposed) return;
    const message = raw as BootstrapMessage | DataMessage;
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'data') {
      // 关键路径：二进制直灌。xterm 内部自带写队列与 UTF-8 增量解码，
      // 这里绝不做字符串转换或手动缓冲，否则高频输出会明显掉帧。
      const payload = (message as DataMessage).data;
      this.receivedFrames++;
      this.receivedBytes += payload ? payload.byteLength : 0;
      this.term.write(payload);
      if (this.probes.length) this.feedProbes(payload);
      this.callbacks.onOutput(this);
      return;
    }

    if (message.type === 'bootstrap') {
      const boot = message as BootstrapMessage;
      this.sessionId = boot.sessionId;
      if (boot.config?.name) this.config = { ...this.config, ...boot.config } as SshConfig;
      if (boot.status) this.setStatus(boot.status);
    }
  }

  /* ================================================================== */
  /* 发送                                                                */
  /* ================================================================== */

  private sendWrite(data: string | Uint8Array): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    try {
      let payload: Uint8Array;
      if (typeof data === 'string') {
        // 输入流量极小，编码开销可忽略
        this.lastSent = data;
        payload = new TextEncoder().encode(data);
      } else {
        payload = data;
      }
      this.sentInputBytes += payload.byteLength;
      // 用 invoke 发送输入：流量小、可靠性优先（高频输出仍走 MessagePort 通道）
      void api.writeSession(sessionId, payload);
    } catch (err) {
      console.warn('[terminal] 发送输入失败', err);
    }
  }

  /** 直接发送原始字节（用于 ANSI 应答序列） */
  sendRaw(bytes: number[]): void {
    this.sendWrite(new Uint8Array(bytes));
  }

  /* ================================================================== */
  /* 远端探测（工具面板）                                                 */
  /* ================================================================== */

  /**
   * 在远端 shell 里执行一条只读探测表达式并取回其输出。
   *
   * 实现：向会话写入 `echo <M>_'S'__; <expr>; echo <M>_'E'__`，收集两行输出标记
   * 之间的内容。两个防误命中设计：
   * 1. 标记在命令里用引号拆开（`'S'`）——键入命令的回显永远是带引号的原始形态，
   *    不含连续的标记串；只有真正的 echo 输出行才恰好等于标记。
   * 2. 标记按「行首」匹配，进一步排除回显/跟踪（set -x）等带前缀的场景。
   *
   * 限制：要求当前处于空闲的命令提示符下；若 shell 正有前台任务或输入行有
   * 残留字符，探测会随之失败（以超时报错，不会执行任何写操作）。
   */
  async runProbe(expr: string, timeoutMs = 4000): Promise<string> {
    if (!this.sessionId || !this.channel) throw new Error('没有活动会话');
    if (this.status !== 'connected') throw new Error('终端未连接（认证完成前无法探测远端目录）');
    if (this.disposed) throw new Error('标签已关闭');

    const seq = ++this.probeCounter;
    const begin = `__DSHQ_${seq}_S__`;
    const end = `__DSHQ_${seq}_E__`;

    const promise = new Promise<string>((resolve, reject) => {
      const waiter: ProbeWaiter = {
        beginMarker: begin,
        endMarker: end,
        started: false,
        buffer: '',
        resolve,
        reject,
        timer: 0,
      };
      waiter.timer = window.setTimeout(() => {
        this.probes = this.probes.filter((w) => w !== waiter);
        reject(new Error('探测超时：请确认终端停留在命令提示符下'));
      }, timeoutMs);
      this.probes.push(waiter);
    });

    this.sendWrite(`echo __DSHQ_${seq}_'S'__; ${expr}; echo __DSHQ_${seq}_'E'__\r`);
    return promise;
  }

  /** 当前工作目录（$PWD，绝对路径；csh 类 shell 不适用） */
  async probeCwd(): Promise<string> {
    const out = await this.runProbe(`printf '%s\\n' "$PWD"`);
    const line = out.split(/\r?\n/).find((l) => l.trim());
    if (!line) throw new Error('无法获取远端当前目录');
    return line.trim();
  }

  /** 远端用户主目录（$HOME，用于本地盘符映射） */
  async probeHome(): Promise<string> {
    const out = await this.runProbe(`printf '%s\\n' "$HOME"`);
    const line = out.split(/\r?\n/).find((l) => l.trim());
    if (!line) throw new Error('无法获取远端主目录');
    return line.trim();
  }

  /**
   * path 下的子目录列表，返回完整路径（~ 展开后的绝对路径）。
   * 注意：路径引号必须让 ~ 留在引号外（quoteRemotePath），否则
   * ls 会把带引号的 '~/MTK' 当成字面目录名去查找，结果永远为空。
   */
  async probeSubdirs(path: string): Promise<string[]> {
    const quoted = quoteRemotePath(path.replace(/\/+$/, ''));
    const out = await this.runProbe(`ls -1d ${quoted}/*/ 2>/dev/null`);
    const dirs = out
      .split(/\r?\n/)
      .map((l) => l.replace(/\/+\s*$/, '').trim())
      .filter((l) => l);
    return [...new Set(dirs)];
  }

  /** 输出到达时旁路喂给挂起中的探测（仅在有待处理探测时才会进入） */
  private feedProbes(payload: Uint8Array): void {
    if (!payload || !payload.byteLength) return;
    const chunk = this.probeDecoder.decode(payload, { stream: true });
    for (const waiter of [...this.probes]) {
      waiter.buffer += chunk;
      if (waiter.buffer.length > 256 * 1024) {
        this.probes = this.probes.filter((w) => w !== waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error('探测输出异常（标记丢失）'));
        continue;
      }
      if (!waiter.started) {
        // 定位起始标记：要么在缓冲区开头，要么紧跟在某个换行之后（行首锚定）
        let beginIdx = -1;
        if (waiter.buffer.startsWith(waiter.beginMarker)) {
          beginIdx = 0;
        } else {
          const at = waiter.buffer.indexOf('\n' + waiter.beginMarker);
          if (at >= 0) beginIdx = at + 1;
        }
        if (beginIdx < 0) continue;
        waiter.started = true;
        // 丢弃起始标记所在的整行；行尾可能尚未到达，此时清空缓冲等后续内容即可。
        // 注意必须从「标记之后」开始找行尾——之前从 \n 本身开始找，
        // indexOf 返回的还是这个 \n，导致起始行没被丢弃、标记串被当成结果返回。
        const nl = waiter.buffer.indexOf('\n', beginIdx + waiter.beginMarker.length);
        waiter.buffer = nl < 0 ? '' : waiter.buffer.slice(nl + 1);
      }
      const end =
        waiter.buffer.startsWith(waiter.endMarker) ? 0 : waiter.buffer.indexOf('\n' + waiter.endMarker);
      if (end < 0) continue;
      this.finishProbe(waiter, waiter.buffer.slice(0, end).replace(/\r/g, ''));
    }
  }

  private finishProbe(waiter: ProbeWaiter, value: string): void {
    this.probes = this.probes.filter((w) => w !== waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  /** 向远端发送一行命令并执行（工具面板「发送到终端」用） */
  sendLine(text: string): void {
    if (this.status !== 'connected') return;
    this.sendWrite(text + '\r');
    this.focus();
  }

  /**
   * 向终端输入文本但不按回车（工具面板「单编快捷命令」用）：
   * 命令落在远端行编辑器里，用户检查/修改后自己按 Enter 执行。
   */
  typeText(text: string): void {
    if (this.status !== 'connected' || !text) return;
    this.sendWrite(text);
    this.focus();
  }

  private sendResize(cols: number, rows: number): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    void api.resizeSession(sessionId, { cols, rows });
  }

  /* ================================================================== */
  /* 渲染器（WebGL）                                                     */
  /* ================================================================== */

  /** 挂载渲染器：优先 WebGL，失败降级 Canvas，再失败用 DOM */
  private attachRenderer(): void {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        console.warn('[terminal] WebGL 上下文丢失，降级为 Canvas 渲染');
        this.webglRebuilds = 99; // 不再尝试重建
        try {
          webgl.dispose();
        } catch {
          /* ignore */
        }
        this.webgl = null;
        this.rendererKind = 'dom';
        this.attachCanvasFallback();
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
      this.rendererKind = 'webgl';
    } catch (err) {
      console.warn('[terminal] WebGL 初始化失败，降级为 Canvas 渲染', err);
      this.attachCanvasFallback();
    }
  }

  private attachCanvasFallback(): void {
    if (this.disposed || this.canvas) return;
    try {
      const canvas = new CanvasAddon();
      this.term.loadAddon(canvas);
      this.canvas = canvas;
      this.rendererKind = 'canvas';
    } catch (err) {
      console.warn('[terminal] Canvas 渲染器也不可用，使用 DOM 渲染', err);
      this.rendererKind = 'dom';
    }
  }

  /**
   * 重建 WebGL 渲染器。
   *
   * Windows 上拖拽改变窗口大小时，WebGL 纹理图集里的旧尺寸字形会残留在画布上，
   * 表现为「残影 / 花屏 / 上一帧的字符」。重建渲染器会丢弃整张图集并按新尺寸
   * 重新栅格化，是消除残留最彻底的做法。仅在 resize 停止后执行一次，开销可控。
   */
  private rebuildWebGL(): void {
    if (this.rendererKind !== 'webgl' || this.disposed) return;
    if (this.webglRebuilds >= 3) return; // 防止极端情况下反复重建
    this.webglRebuilds++;
    try {
      this.webgl?.dispose();
    } catch {
      /* ignore */
    }
    this.webgl = null;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try {
          webgl.dispose();
        } catch {
          /* ignore */
        }
        this.webgl = null;
        this.attachCanvasFallback();
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
      this.rendererKind = 'webgl';
    } catch (err) {
      console.warn('[terminal] WebGL 重建失败，降级为 Canvas', err);
      this.attachCanvasFallback();
    }
  }

  /* ================================================================== */
  /* 尺寸与重绘                                                          */
  /* ================================================================== */

  private observeResize(host: HTMLElement): void {
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(host);
  }

  /** 合并同一帧内的多次尺寸事件，避免 fit() 抖动 */
  private scheduleFit(): void {
    if (this.disposed) return;
    if (this.rafHandle) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      this.fitNow();
    });
  }

  /**
   * 执行一次自适应：
   * fit() -> xterm 触发 onResize -> 端口 resize -> 远端 setWindow(rows, cols, 0, 0)
   * 随后在 resize 静默后重建 WebGL，消除残留。
   */
  fitNow(): void {
    if (this.disposed || !this.pane.isConnected) return;
    // 隐藏标签页尺寸为 0，fit() 会算出非法行列数
    if (this.pane.clientWidth <= 0 || this.pane.clientHeight <= 0) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* 尺寸处于瞬时非法状态时忽略 */
    }
    // 主动补齐一次，避免 cols/rows 未变化时 onResize 不触发导致的远端窗口大小滞后
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (cols !== this.lastSize.cols || rows !== this.lastSize.rows) {
      this.lastSize = { cols, rows };
      this.sendResize(cols, rows);
    }
    this.scheduleRendererRefresh();
  }

  /** resize 静默后刷新渲染器，确保无残留 */
  private scheduleRendererRefresh(): void {
    if (this.resizeSettleTimer) window.clearTimeout(this.resizeSettleTimer);
    this.resizeSettleTimer = window.setTimeout(() => {
      this.resizeSettleTimer = null;
      if (this.disposed) return;
      this.rebuildWebGL();
      // 重建后再校正一次，保证纹理尺寸与容器完全一致
      try {
        this.fitAddon.fit();
      } catch {
        /* ignore */
      }
    }, 140);
  }

  /** 标签被激活时调用：此时容器才有真实尺寸 */
  activate(): void {
    // 显示后立即 fit，保证切回标签时行列数正确
    requestAnimationFrame(() => {
      this.fitNow();
      this.focus();
    });
  }

  focus(): void {
    if (this.disposed) return;
    try {
      this.term.focus();
    } catch {
      /* ignore */
    }
  }

  /* ================================================================== */
  /* 查找 / 清屏 / 快捷键                                                */
  /* ================================================================== */

  toggleSearch(force?: boolean): void {
    const open = force ?? !this.searchOpen;
    this.searchOpen = open;
    this.searchBar.classList.toggle('open', open);
    if (open) {
      this.searchInput.focus();
      this.searchInput.select();
    } else {
      this.searchAddon.clearDecorations();
      this.searchCount.textContent = '';
      this.focus();
    }
    this.callbacks.onSearchToggle(this, open);
  }

  get isSearchOpen(): boolean {
    return this.searchOpen;
  }

  private doSearch(direction: 'next' | 'prev'): void {
    const query = this.searchInput.value;
    if (!query) {
      this.searchAddon.clearDecorations();
      this.searchCount.textContent = '';
      return;
    }
    const options = {
      decorations: {
        matchBackground: '#4c8dff66',
        matchOverviewRuler: '#4c8dff',
        activeMatchBackground: '#ffb020cc',
        activeMatchColorOverviewRuler: '#ffb020',
      },
      caseSensitive: false,
    };
    const found =
      direction === 'next'
        ? this.searchAddon.findNext(query, options)
        : this.searchAddon.findPrevious(query, options);
    this.searchCount.textContent = found ? '已匹配' : '无结果';
  }

  clear(): void {
    this.term.clear();
    // clear() 只清视口，reset() 会连滚动缓冲一起清空
    this.term.write('\x1b[2J\x1b[3J\x1b[H');
    this.focus();
  }

  selectAll(): void {
    this.term.selectAll();
  }

  async copySelection(): Promise<boolean> {
    const text = this.getSelection();
    if (!text) return false;
    return copyText(text);
  }

  getSelection(): string {
    try {
      const selection = this.term.getSelection();
      return selection ?? '';
    } catch {
      return '';
    }
  }

  hasSelection(): boolean {
    return this.getSelection().length > 0;
  }

  async paste(): Promise<void> {
    const text = await readClipboard();
    if (text) this.term.paste(text);
    // 右键菜单粘贴后焦点会停在已关闭的菜单层，xterm 输入框拿不回来，
    // 表现为必须手动点一下终端才能输入 —— 这里统一把焦点拿回
    this.focus();
  }

  /**
   * 按键拦截。
   * 返回 false 表示阻止 xterm 处理该事件。
   * 规则：Ctrl+Shift+* 归应用（复制/粘贴/查找），其余（含 Ctrl+C、Ctrl+D、Tab、
   * 方向键、Ctrl+V 的原始字节 0x16）全部交给远端，保证 vim/top 等全屏程序正常。
   */
  private handleKeyEvent(event: KeyboardEvent): boolean {
    const ctrl = event.ctrlKey || event.metaKey;
    const shift = event.shiftKey;

    if (ctrl && shift) {
      const key = event.key.toLowerCase();
      if (key === 'c') {
        event.preventDefault();
        event.stopPropagation();
        void this.copySelection();
        return false;
      }
      if (key === 'v') {
        event.preventDefault();
        event.stopPropagation();
        void this.paste();
        return false;
      }
      if (key === 'f') {
        event.preventDefault();
        event.stopPropagation();
        this.toggleSearch(true);
        return false;
      }
      if (key === 'a') {
        event.preventDefault();
        event.stopPropagation();
        this.selectAll();
        return false;
      }
    }

    // Shift+Insert 粘贴（Windows 传统习惯）
    if (shift && event.key === 'Insert') {
      event.preventDefault();
      event.stopPropagation();
      void this.paste();
      return false;
    }

    return true;
  }

  /** 在标签内直接追加一行提示（本地生成，不经过 SSH） */
  private writeNotice(text: string): void {
    this.term.write(text);
  }

  private writeError(text: string): void {
    this.term.write(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
  }

  /* ================================================================== */
  /* 设置联动                                                            */
  /* ================================================================== */

  updateSettings(settings: AppSettings): void {
    const prev = this.settings;
    this.settings = settings;
    this.term.options.fontSize = settings.fontSize;
    this.term.options.fontFamily = settings.fontFamily;
    this.term.options.lineHeight = settings.lineHeight;
    this.term.options.cursorStyle = settings.cursorStyle;
    this.term.options.cursorBlink = settings.cursorBlink;
    if (settings.scrollback !== prev.scrollback) {
      this.term.options.scrollback = settings.scrollback;
    }
    // 字号/字体/行高变化后行列数会变，必须重新 fit 并通知远端
    this.scheduleFit();
  }

  updateTheme(themeName: string): void {
    this.term.options.theme = getTheme(themeName).terminal;
    // 主题切换会改变字形缓存，重建渲染器可避免旧配色残留
    try {
      this.term.refresh(0, Math.max(0, this.term.rows - 1));
    } catch {
      /* ignore */
    }
    window.setTimeout(() => this.rebuildWebGL(), 60);
  }

  private setStatus(status: SessionStatus, message?: string): void {
    if (this.status === status && !message) return;
    this.status = status;
    this.callbacks.onStatus(this, status, message);
  }

  /** 会话结束后重置未读标记用 */
  markRead(): void {
    this.callbacks.onOutput(this);
  }

  /** 供容器判断是否为同一配置 */
  get configId(): string {
    return this.config.id;
  }
}
