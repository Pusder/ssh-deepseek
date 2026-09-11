import type { AppSettings, SessionStatus, SshConfig } from '../../main/types';
import { TerminalTab } from './terminal';
import { el } from './util';

export interface TabManagerCallbacks {
  onActiveChange(tab: TerminalTab | null): void;
  onTabClosed(tab: TerminalTab): void;
  onCountChange(count: number): void;
}

interface TabEntry {
  tab: TerminalTab;
  button: HTMLElement;
  dot: HTMLElement;
  title: HTMLElement;
  closeButton: HTMLButtonElement;
}

/**
 * 标签栏管理器。
 *
 * 所有标签的终端实例只创建一次并常驻 DOM（非激活标签仅 display:none），
 * 这样切换标签时无需重建 xterm 实例与 WebGL 上下文，切换瞬间完成。
 */
export class TabManager {
  private entries = new Map<string, TabEntry>();
  private order: string[] = [];
  private activeId: string | null = null;

  constructor(
    private tabListEl: HTMLElement,
    private paneStackEl: HTMLElement,
    private callbacks: TabManagerCallbacks,
  ) {}

  get count(): number {
    return this.order.length;
  }

  get active(): TerminalTab | null {
    return this.activeId ? this.entries.get(this.activeId)?.tab ?? null : null;
  }

  get all(): TerminalTab[] {
    return this.order.map((id) => this.entries.get(id)!.tab).filter(Boolean);
  }

  /** 查找绑定到某配置的所有标签 */
  findByConfig(configId: string): TerminalTab[] {
    return this.all.filter((tab) => tab.configId === configId);
  }

  /**
   * 创建新标签。返回的终端尚未连接，由调用方决定何时 connect()。
   *
   * 若 allowReuse 为真且已存在同配置的「已断开」标签，则复用该标签重连，
   * 此时 reused=true —— 调用方不应再次调用 connect()，否则会建立两条连接。
   */
  createTab(
    config: SshConfig,
    settings: AppSettings,
    terminalCallbacks: ConstructorParameters<typeof TerminalTab>[2],
    allowReuse = true,
  ): { tab: TerminalTab; reused: boolean } {
    if (allowReuse) {
      const reusable = this.findByConfig(config.id).find(
        (tab) => tab.currentStatus === 'disconnected' || tab.currentStatus === 'error',
      );
      if (reusable) {
        this.activate(reusable.id);
        void reusable.reconnect();
        return { tab: reusable, reused: true };
      }
    }

    const tab = new TerminalTab(config, settings, terminalCallbacks);

    // 先把 pane 插入 DOM，Terminal 构造时才能测量到真实尺寸
    this.paneStackEl.appendChild(tab.pane);

    const dot = el('span', { className: 'dot dot-idle' });
    const title = el('span', { className: 'tab-title', text: tab.displayName });
    const closeButton = el('button', { className: 'tab-close', text: '✕', title: '关闭标签 (Ctrl+W)' });
    const button = el('div', {
      className: 'tab',
      title: `${config.username ? config.username + '@' : ''}${config.host}:${config.port}`,
      children: [dot, title, closeButton],
    });

    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.closeTab(tab.id);
    });
    button.addEventListener('click', () => this.activate(tab.id));
    button.addEventListener('auxclick', (event) => {
      // 鼠标中键关闭，符合浏览器习惯
      if ((event as MouseEvent).button === 1) {
        event.preventDefault();
        this.closeTab(tab.id);
      }
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.activate(tab.id);
    });

    this.tabListEl.appendChild(button);
    this.entries.set(tab.id, { tab, button, dot, title, closeButton });
    this.order.push(tab.id);

    this.activate(tab.id);
    this.callbacks.onCountChange(this.count);
    return { tab, reused: false };
  }

  activate(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;

    // 隐藏旧标签
    if (this.activeId && this.activeId !== tabId) {
      const prev = this.entries.get(this.activeId);
      if (prev) {
        prev.button.classList.remove('active');
        prev.tab.pane.classList.remove('active');
      }
    }

    this.activeId = tabId;
    entry.button.classList.add('active');
    entry.tab.pane.classList.add('active');
    entry.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    // 标签变为可见后才 fit，否则尺寸为 0
    entry.tab.activate();
    this.callbacks.onActiveChange(entry.tab);
  }

  /** 关闭标签：断开 SSH 并销毁终端 */
  closeTab(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;

    const index = this.order.indexOf(tabId);
    const wasActive = this.activeId === tabId;

    // 先通知主进程关闭 SSH 连接，再销毁渲染层资源，避免连接泄漏
    const sessionId = entry.tab.session;
    if (sessionId) {
      void window.dshSsh.closeSession(sessionId).catch(() => undefined);
    }

    entry.tab.dispose();
    entry.button.remove();
    this.entries.delete(tabId);
    this.order = this.order.filter((id) => id !== tabId);
    this.callbacks.onTabClosed(entry.tab);
    this.callbacks.onCountChange(this.count);

    if (wasActive) {
      this.activeId = null;
      const next = this.order[Math.min(index, this.order.length - 1)];
      if (next) this.activate(next);
      else this.callbacks.onActiveChange(null);
    }
  }

  closeActive(): void {
    if (this.activeId) this.closeTab(this.activeId);
  }

  closeAll(): void {
    for (const id of [...this.order]) this.closeTab(id);
  }

  /** 按索引切换标签（Ctrl+Tab / Ctrl+1..9） */
  activateByIndex(index: number): void {
    const id = this.order[index];
    if (id) this.activate(id);
  }

  activateNext(delta = 1): void {
    if (!this.order.length) return;
    const current = this.activeId ? this.order.indexOf(this.activeId) : 0;
    const next = (current + delta + this.order.length) % this.order.length;
    this.activate(this.order[next]);
  }

  /* --------------------------- 状态同步 --------------------------- */

  updateStatus(tab: TerminalTab, status: SessionStatus): void {
    const entry = this.entries.get(tab.id);
    if (!entry) return;
    entry.dot.className = `dot dot-${status === 'connected' ? 'connected' : status}`;
    entry.tab.pane.dataset.status = status;
    const suffix =
      status === 'disconnected' ? '（已断开）' : status === 'error' ? '（错误）' : status === 'connecting' ? '（连接中）' : '';
    entry.title.textContent = tab.displayName + suffix;
    entry.button.title = `${tab.config.username ? tab.config.username + '@' : ''}${tab.config.host}:${tab.config.port} · ${statusText(status)}`;
    this.syncSize(tab);
  }

  /** 把终端行列数同步到 DOM，便于状态栏/自动化检查读取真实尺寸 */
  syncSize(tab: TerminalTab): void {
    const entry = this.entries.get(tab.id);
    if (!entry) return;
    const { cols, rows } = tab.size;
    entry.tab.pane.dataset.cols = String(cols);
    entry.tab.pane.dataset.rows = String(rows);
    entry.button.dataset.cols = String(cols);
    entry.button.dataset.rows = String(rows);
  }

  updateTitle(tab: TerminalTab, title: string): void {
    const entry = this.entries.get(tab.id);
    if (!entry) return;
    entry.title.textContent = title;
  }

  /**
   * 更新当前标签的字体 / 字号 / 主题。
   * 因为 WebGL 字形缓存与字号强相关，全部标签一起更新。
   */
  updateSettings(settings: AppSettings): void {
    for (const tab of this.all) {
      tab.updateSettings(settings);
      tab.updateTheme(settings.theme);
    }
  }

  get rendererLabel(): string {
    const tab = this.active;
    return tab ? tab.rendererName : '—';
  }
}

function statusText(status: SessionStatus): string {
  switch (status) {
    case 'connecting':
      return '连接中';
    case 'connected':
      return '已连接';
    case 'disconnected':
      return '已断开';
    case 'error':
      return '连接错误';
    default:
      return '未连接';
  }
}
