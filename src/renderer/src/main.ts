import '@xterm/xterm/css/xterm.css';
import '../styles/base.css';
import '../styles/layout.css';
import '../styles/terminal.css';
import '../styles/dialog.css';

import type { AppSettings, SessionStatus, SshConfig, TermSize } from '../../main/types';
import { DEFAULT_SETTINGS } from '../../main/types';
import { api } from './api';
import { openSettingsDialog, openShortcutsDialog } from './config-dialog';
import { bindContextMenu, type ContextMenuItem } from './context-menu';
import { confirmDialog } from './dialogs';
import { Sidebar } from './sidebar';
import { TabManager } from './tabs';
import { TerminalTab, type TerminalTabCallbacks } from './terminal';
import { applyUiTheme, getTheme, nextTheme } from './themes';
import { toast } from './toast';
import { clamp, formatDuration, need } from './util';

/* ===================================================================== */
/* 应用状态                                                               */
/* ===================================================================== */

let settings: AppSettings = { ...DEFAULT_SETTINGS };
let configs: SshConfig[] = [];
let tabs: TabManager;
let sidebar: Sidebar;

/** 当前标签的会话连接时间，用于状态栏计时 */
let activeConnectedAt = 0;
const connectedAtMap = new Map<string, number>();

/* ===================================================================== */
/* 启动                                                                   */
/* ===================================================================== */

async function boot(): Promise<void> {
  applyUiTheme(settings.theme);

  const terminalStack = need<HTMLElement>('#terminal-stack');
  const terminalArea = need<HTMLElement>('#terminal-area');
  const tabList = need<HTMLElement>('#tab-list');
  const welcome = need<HTMLElement>('#welcome');

  /* ---------------------------- 标签管理 ---------------------------- */
  tabs = new TabManager(tabList, terminalStack, {
    onActiveChange(tab) {
      welcome.classList.toggle('hidden', !!tab);
      updateStatusBar(tab);
      updateTabButtons();
      updateWindowTitle(tab);
      if (tab?.isSearchOpen) tab.toggleSearch(false);
    },
    onTabClosed() {
      if (!tabs.count) welcome.classList.remove('hidden');
      updateTabButtons();
      syncSidebarActive();
    },
    onCountChange() {
      updateTabButtons();
      syncSidebarActive();
    },
  });

  /* ---------------------------- 侧边栏 ------------------------------ */
  sidebar = new Sidebar(
    need<HTMLElement>('#config-list'),
    need<HTMLInputElement>('#config-search'),
    need<HTMLElement>('#btn-new-config'),
    {
      onConnect: (config) => void connectConfig(config),
      onNewConfig: () => void createAndConnect(),
      onEdit: (config) =>
        void sidebar.editConfig(config).then((saved) => {
          // 配置变了，标题类信息跟着更新
          if (saved) for (const tab of tabs.findByConfig(saved.id)) tab.updateSettings(settings);
        }),
      onDuplicated: () => undefined,
      onDeleted: (id) => {
        const affected = tabs.findByConfig(id);
        for (const tab of affected) tabs.closeTab(tab.id);
      },
      onSelectionChange: () => updateTabButtons(),
      onSaved: refreshConfigs,
      onDisconnectConfig: (config) => {
        for (const tab of tabs.findByConfig(config.id)) void tab.disconnect();
      },
    },
  );

  /* --------------------------- 终端尺寸联动 -------------------------- */
  const observe = new ResizeObserver(() => {
    // 只有可见标签需要 fit；隐藏标签在 activate() 时会补一次
    for (const tab of tabs.all) {
      if (tab.pane.classList.contains('active')) tab.fitNow();
    }
  });
  observe.observe(terminalArea);

  // 拖动窗口期间禁用过渡动画，停止 180ms 后视为结束
  let resizeTimer: number | null = null;
  window.addEventListener('resize', () => {
    document.body.classList.add('resizing');
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null;
      document.body.classList.remove('resizing');
      // 收尾再校正一次，确保没有任何残留
      const active = tabs.active;
      if (active) active.fitNow();
    }, 180);
  });

  /* --------------------------- 右键菜单 ----------------------------- */
  bindContextMenu(terminalArea, (event) => {
    const pane = (event.target as HTMLElement).closest<HTMLElement>('.term-pane');
    const tab = pane ? tabs.all.find((t) => t.id === pane.dataset.tabId) : tabs.active;
    if (!tab) return null;
    if (tabs.active?.id !== tab.id) tabs.activate(tab.id);
    return buildTerminalMenu(tab);
  });

  /* --------------------------- 标签栏按钮 --------------------------- */
  need<HTMLElement>('#btn-tab-close').addEventListener('click', () => tabs.closeActive());
  need<HTMLElement>('#btn-tab-reconnect').addEventListener('click', () => void reconnectActive());
  need<HTMLElement>('#btn-tab-disconnect').addEventListener('click', () => void disconnectActive());
  need<HTMLElement>('#btn-settings').addEventListener('click', () => void openSettings());
  need<HTMLElement>('#btn-shortcuts').addEventListener('click', () => openShortcutsDialog());
  need<HTMLElement>('#welcome-new').addEventListener('click', () => void createAndConnect());

  /* --------------------------- 主进程事件 --------------------------- */
  api.onSessionStatus((event) => {
    const tab = tabs.all.find((t) => t.session === event.sessionId);
    if (!tab) return;
    tab.handleStatus(event.status, event.message);
    if (event.status === 'connected') {
      connectedAtMap.set(event.sessionId, Date.now());
      if (tabs.active?.id === tab.id) activeConnectedAt = Date.now();
    }
    if (tabs.active?.id === tab.id) updateStatusBar(tab);
    syncSidebarActive();
  });

  api.onSessionEnded((event) => {
    connectedAtMap.delete(event.sessionId);
    const tab = tabs.all.find((t) => t.session === event.sessionId);
    if (!tab) return;
    tab.handleEnded(event);
    if (tabs.active?.id === tab.id) {
      activeConnectedAt = 0;
      updateStatusBar(tab);
    }
    // 状态可能早已是 disconnected（onStatus 因状态未变化而不触发），
    // 这里必须无条件刷新一次按钮与侧栏，否则断开后按钮仍停留在「可点」状态。
    updateTabButtons();
    syncSidebarActive();
  });

  api.onMenuCommand((command) => handleMenuCommand(command));

  /* --------------------------- 全局快捷键 --------------------------- */
  document.addEventListener(
    'keydown',
    (event) => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (!ctrl) return;

      // Ctrl+Tab / Ctrl+Shift+Tab 切换标签
      if (event.key === 'Tab') {
        event.preventDefault();
        tabs.activateNext(event.shiftKey ? -1 : 1);
        return;
      }
      // Ctrl+1..9 直达标签
      if (/^[1-9]$/.test(event.key) && !event.shiftKey) {
        const index = Number(event.key) - 1;
        if (index < tabs.count) {
          event.preventDefault();
          tabs.activateByIndex(index);
        }
        return;
      }
      // Ctrl+, 打开设置（与 VS Code 一致）
      if (event.key === ',' && !event.shiftKey) {
        event.preventDefault();
        void openSettings();
      }
    },
    true,
  );

  // 阻止在非输入区域内拖动选中的文本导致的怪异选择行为
  document.addEventListener('dragstart', (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest('input, textarea')) event.preventDefault();
  });

  /* --------------------------- 初始化数据 --------------------------- */
  settings = await api.getSettings();
  applyUiTheme(settings.theme);
  await refreshConfigs();
  updateStatusBar(null);
  updateStatusBarRenderer();
  installE2EHooks();

  // 每秒刷新一次状态栏计时
  window.setInterval(() => {
    if (activeConnectedAt && tabs.active) updateStatusBar(tabs.active);
  }, 1000);

  // 首次启动给出提示
  if (!configs.length) {
    toast('欢迎使用深寻 SSH，先新建一个服务器配置吧', 'info', 3600);
  }
}

/* ===================================================================== */
/* 配置与会话                                                             */
/* ===================================================================== */

async function refreshConfigs(): Promise<void> {
  configs = await api.listConfigs();
  sidebar.setConfigs(configs);
  syncSidebarActive();
}

/** 让左侧列表显示哪些配置当前有活动会话 */
function syncSidebarActive(): void {
  const map = new Map<string, SessionStatus>();
  for (const tab of tabs.all) {
    const status = tab.currentStatus;
    if (status === 'connected' || status === 'connecting') {
      map.set(tab.configId, status);
    }
  }
  // 先清理已不在活动状态的
  for (const config of configs) {
    if (!map.has(config.id)) sidebar.setActive(config.id, null);
  }
  for (const [configId, status] of map) sidebar.setActive(configId, status);
}

/** 新建配置并立即连接 */async function createAndConnect(): Promise<void> {
  const saved = await sidebar.createConfig();
  if (saved) await connectConfig(saved);
}

async function connectConfig(config: SshConfig): Promise<void> {
  if (!config.host) {
    toast('该配置缺少主机地址，请先编辑', 'err');
    return;
  }
  // 复用已断开的标签时，createTab 内部已发起重连；新标签才需要主动连接，
  // 否则会对同一会话发起两次连接。
  const { tab, reused } = tabs.createTab(config, settings, terminalCallbacks);
  if (!reused) await tab.connect();
  updateStatusBar(tab);
}

const terminalCallbacks: TerminalTabCallbacks = {
  onStatus(tab, status) {
    tabs.updateStatus(tab, status);
    if (tabs.active?.id === tab.id) updateStatusBar(tab);
    syncSidebarActive();
  },
  onOutput() {
    /* 已读状态由 xterm 自身滚动管理，这里无需额外处理 */
  },
  onTitle(tab, title) {
    tabs.updateTitle(tab, title);
    if (tabs.active?.id === tab.id) updateWindowTitle(tab);
  },
  onCloseRequested(tab) {
    tabs.closeTab(tab.id);
  },
  onSearchToggle(tab) {
    if (tabs.active?.id === tab.id) updateWindowTitle(tab);
  },
};

async function reconnectActive(): Promise<void> {
  const tab = tabs.active;
  if (!tab) {
    toast('当前没有打开的终端标签', 'warn');
    return;
  }
  activeConnectedAt = 0;
  await tab.reconnect();
}

async function disconnectActive(): Promise<void> {
  const tab = tabs.active;
  if (!tab) {
    toast('当前没有打开的终端标签', 'warn');
    return;
  }
  if (!tab.session) {
    toast('当前标签未处于连接状态', 'warn');
    return;
  }
  await tab.disconnect();
}

/* ===================================================================== */
/* 右键菜单                                                               */
/* ===================================================================== */

function buildTerminalMenu(tab: TerminalTab): ContextMenuItem[] {
  const hasSelection = tab.hasSelection();
  const connected = tab.currentStatus === 'connected';
  const info = `${tab.config.username ? tab.config.username + '@' : ''}${tab.config.host}:${tab.config.port}`;
  return [
    {
      label: '复制',
      key: 'Ctrl+Shift+C',
      disabled: !hasSelection,
      onClick: () => void tab.copySelection().then((ok) => ok && toast('已复制选中内容', 'ok')),
    },
    {
      label: '粘贴',
      key: 'Ctrl+Shift+V',
      onClick: () => void tab.paste(),
    },
    {
      label: '全选',
      key: 'Ctrl+Shift+A',
      onClick: () => tab.selectAll(),
    },
    { separator: true },
    {
      label: '查找…',
      key: 'Ctrl+Shift+F',
      onClick: () => tab.toggleSearch(true),
    },
    {
      label: '清屏',
      key: 'Ctrl+K',
      onClick: () => tab.clear(),
    },
    { separator: true },
    {
      label: '重新连接',
      key: 'Ctrl+R',
      onClick: () => void reconnectActive(),
    },
    {
      label: '断开连接',
      disabled: !connected,
      onClick: () => void tab.disconnect(),
    },
    {
      label: '关闭标签',
      key: 'Ctrl+W',
      danger: true,
      onClick: () => tabs.closeTab(tab.id),
    },
    { separator: true },
    {
      label: '放大字体',
      key: 'Ctrl++',
      onClick: () => void changeFontSize(1),
    },
    {
      label: '缩小字体',
      key: 'Ctrl+-',
      onClick: () => void changeFontSize(-1),
    },
    {
      label: '复制 SSH 命令',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(`ssh ${info}`);
          toast(`已复制：ssh ${info}`, 'ok');
        } catch {
          toast('复制失败', 'err');
        }
      },
    },
  ];
}

/* ===================================================================== */
/* 设置与命令                                                             */
/* ===================================================================== */

async function changeFontSize(delta: number): Promise<void> {
  const fontSize = clamp(settings.fontSize + delta, 8, 40);
  if (fontSize === settings.fontSize) return;
  settings = await api.saveSettings({ fontSize });
  tabs.updateSettings(settings);
  toast(`字号：${settings.fontSize}px`, 'info', 1200);
  const active = tabs.active;
  if (active) updateStatusBar(active);
}

async function toggleTheme(): Promise<void> {
  const theme = nextTheme(settings.theme);
  settings = await api.saveSettings({ theme });
  applyUiTheme(theme);
  tabs.updateSettings(settings);
  toast(`主题：${getTheme(theme).label}`, 'info', 1500);
}

async function openSettings(): Promise<void> {
  const before = settings;
  const result = await openSettingsDialog(settings);
  if (result.saved) {
    /**
     * 保存路径必须采用对话框返回的设置来刷新界面。
     *
     * 之前的写法是保存后重新 getSettings() 再应用，一旦「写入」与「回读」之间出现任何
     * 时序差异（例如另一次写入覆盖、或回读拿到旧快照），界面就会被旧主题覆盖，
     * 表现为「提示设置已保存，但主题没变」。对话框返回值就是本次保存的意图，直接生效。
     */
    settings = { ...settings, ...result.settings };
    applyUiTheme(settings.theme);
    tabs.updateSettings(settings);
    updateStatusBarRenderer();
    toast('设置已保存', 'ok');
    const active = tabs.active;
    if (active) updateStatusBar(active);
    return;
  }
  // 取消路径：重新读取存储，丢弃对话框中的临时改动
  settings = await api.getSettings();
  if (settings.theme !== before.theme) applyUiTheme(settings.theme);
}

function handleMenuCommand(command: string): void {
  const tab = tabs.active;
  switch (command) {
    case 'menu:new-config':
      void createAndConnect();
      break;
    case 'menu:reconnect':
      void reconnectActive();
      break;
    case 'menu:disconnect':
      void disconnectActive();
      break;
    case 'menu:close-tab':
      tabs.closeActive();
      break;
    case 'menu:copy':
      if (tab) void tab.copySelection().then((ok) => toast(ok ? '已复制选中内容' : '没有选中内容', ok ? 'ok' : 'warn'));
      break;
    case 'menu:paste':
      void tab?.paste();
      break;
    case 'menu:select-all':
      tab?.selectAll();
      break;
    case 'menu:find':
      if (tab) tab.toggleSearch(true);
      else toast('当前没有打开的终端标签', 'warn');
      break;
    case 'menu:font-inc':
      void changeFontSize(1);
      break;
    case 'menu:font-dec':
      void changeFontSize(-1);
      break;
    case 'menu:font-reset':
      void (async () => {
        settings = await api.saveSettings({ fontSize: DEFAULT_SETTINGS.fontSize });
        tabs.updateSettings(settings);
        toast(`字号已重置为 ${DEFAULT_SETTINGS.fontSize}px`, 'info', 1200);
      })();
      break;
    case 'menu:toggle-theme':
      void toggleTheme();
      break;
    case 'menu:clear':
      tab?.clear();
      break;
    case 'menu:shortcuts':
      openShortcutsDialog();
      break;
    default:
      break;
  }
}

/* ===================================================================== */
/* 状态栏与标题                                                           */
/* ===================================================================== */

function updateStatusBar(tab: TerminalTab | null): void {
  const conn = need<HTMLElement>('#status-conn');
  const hostEl = need<HTMLElement>('#status-host');
  const userEl = need<HTMLElement>('#status-user');
  const sizeEl = need<HTMLElement>('#status-size');
  const timeEl = need<HTMLElement>('#status-time');

  if (!tab) {
    conn.innerHTML = '<i class="dot dot-idle"></i><span>未连接</span>';
    hostEl.textContent = '—';
    userEl.textContent = '—';
    sizeEl.textContent = '—';
    timeEl.textContent = '—';
    return;
  }

  const status = tab.currentStatus;
  const text =
    status === 'connected'
      ? '已连接'
      : status === 'connecting'
        ? '连接中…'
        : status === 'error'
          ? '连接失败'
          : status === 'disconnected'
            ? '已断开'
            : '未连接';
  conn.innerHTML = `<i class="dot dot-${status}"></i><span>${text}</span>`;
  hostEl.textContent = `${tab.config.host}:${tab.config.port}`;
  userEl.textContent = tab.config.username ? `用户 ${tab.config.username}` : '未指定用户';
  const size: TermSize = tab.size;
  sizeEl.textContent = `${size.cols} × ${size.rows}`;
  timeEl.textContent = activeConnectedAt ? `已连接 ${formatDuration(Date.now() - activeConnectedAt)}` : '—';
}

function updateStatusBarRenderer(): void {
  const node = document.getElementById('status-renderer');
  if (!node) return;
  const active = tabs?.active;
  const label = active ? active.rendererName : '—';
  node.textContent = `渲染器：${label} · 回看 ${settings.scrollback} 行`;
}

function updateTabButtons(): void {
  const has = tabs.count > 0;
  const connected = tabs.active?.currentStatus === 'connected';
  need<HTMLButtonElement>('#btn-tab-close').disabled = !has;
  need<HTMLButtonElement>('#btn-tab-reconnect').disabled = !has;
  need<HTMLButtonElement>('#btn-tab-disconnect').disabled = !connected;
  updateStatusBarRenderer();
}

function updateWindowTitle(tab: TerminalTab | null): void {
  if (!tab) {
    document.title = '深寻 SSH';
    return;
  }
  const status = tab.currentStatus;
  const suffix = status === 'connected' ? '' : ' - 已断开';
  document.title = `${tab.displayName}${suffix} — 深寻 SSH`;
}

/* ===================================================================== */
/* 自动化测试锚点                                                         */
/* ===================================================================== */

/**
 * 供端到端测试读取真实的终端状态。
 *
 * 存在的必要性：启用 WebGL 渲染器后 xterm 把字符画在 canvas 上，DOM 中不再保留文本，
 * 外部无法通过读取 DOM 断言终端内容；这里通过 xterm 官方 buffer API 暴露只读快照，
 * 使自动化测试能够验证「远端输出是否真的进入了终端」。
 *
 * 该对象只读取状态、不改变任何行为，对正常运行没有影响。
 */
function installE2EHooks(): void {
  Object.defineProperty(window, '__dshE2E', {
    value: {
      /** 当前标签数量 */
      tabCount: () => tabs.count,
      /** 当前标签状态与尺寸 */
      state() {
        const tab = tabs.active;
        return tab
          ? {
              id: tab.id,
              status: tab.currentStatus,
              cols: tab.size.cols,
              rows: tab.size.rows,
              renderer: tab.rendererName,
              title: tab.displayName,
            }
          : null;
      },
      /** 读取当前视口内的屏幕文本（xterm buffer API） */
      screenText(): string {
        const tab = tabs.active;
        if (!tab) return '';
        const buffer = tab.term.buffer.active;
        const start = buffer.baseY;
        const end = Math.min(buffer.length, start + tab.term.rows);
        const lines: string[] = [];
        for (let i = start; i < end; i++) {
          const line = buffer.getLine(i);
          if (!line) continue;
          lines.push(line.translateToString(true));
          if (!line.isWrapped) lines.push('\n');
        }
        return lines.join('');
      },
      /** 读取回看缓冲的总行数 */
      bufferLength: () => tabs.active?.term.buffer.active.length ?? 0,
      /** 端口数据帧/字节统计，用于确认数据通道是否真的有数据流过 */
      stats: () => tabs.active?.stats ?? { frames: 0, bytes: 0 },
      /** 直接向当前会话的通道发送一条原始消息（诊断用） */
      rawPost: (message: unknown) => tabs.active?.postRaw(message),
      /** 当前会话 ID */
      sessionId: () => tabs.active?.session ?? null,
      /**
       * 向终端注入一段"用户输入"。
       * 走 xterm 的 paste 通路，与真实键盘输入共用同一条 onData -> SSH 链路，
       * 因此可用于自动化验证「输入是否能被远端执行并回显」。
       */
      sendInput: (text: string) => {
        tabs.active?.term.paste(text);
      },
      /**
       * 以「真实键盘输入」的方式注入数据：等价于 xterm 内部处理按键后调用
       * triggerDataEvent，经过的正是 term.onData 同一条链路（不经过 paste 的换行改写）。
       */
      typeInput: (text: string) => {
        tabs.active?.term.input(text, true);
      },
      /** 终端最近一次实际发出的输入内容（解码后，便于诊断输入被改写成什么） */
      lastSentInput: () => tabs.active?.lastSentText ?? '',
      /** 终端已发往远端的输入字节数（判断输入链路是否真的发出） */
      sentInputBytes: () => tabs.active?.sentBytes ?? 0,
      /** 当前界面主题（诊断用） */
      uiTheme: () => document.body.dataset.theme ?? '',
      /** 主进程实际解析到的应用图标路径（打包后应指向 resources/icon.ico） */
      iconPath: () => api.getIconPath(),
      /** 触发一次主题切换（与应用菜单「切换主题」同一入口） */
      toggleTheme: () => toggleTheme(),
      /** 打开设置对话框（与设置按钮同一入口） */
      openSettings: () => openSettings(),
      /** 数据通道是否已建立 */
      channelAlive: () => tabs.active?.channelAlive ?? false,
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

/* ===================================================================== */
/* 全局错误捕获                                                           */
/* ===================================================================== */

window.addEventListener('error', (event) => {
  console.error('[renderer] 未捕获错误', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] 未处理的 Promise 拒绝', event.reason);
});

// 关闭窗口前确认仍有活动连接
window.addEventListener('beforeunload', () => {
  // 主进程会在窗口销毁时统一断开，这里无需额外操作
});

void boot().catch((err) => {
  console.error('[renderer] 启动失败', err);
  const message = err instanceof Error ? err.message : String(err);
  document.body.innerHTML = `<div style="padding:32px;font-family:sans-serif;color:#f0616d">
    <h2>界面初始化失败</h2><pre>${message}</pre></div>`;
});
