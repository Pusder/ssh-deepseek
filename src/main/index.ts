import {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from './ipc';
import { SessionManager } from './sessions';
import { getStore } from './store';
import { AppSettings, SshConfig, TermSize } from './types';

const isDev = !app.isPackaged;
const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD_JS = path.join(__dirname, '..', 'preload', 'index.js');

let mainWindow: BrowserWindow | null = null;
let sessions: SessionManager;

/** 窗口底色，与渲染层主题保持一致可避免 resize 时闪白 */
const WINDOW_BG = '#12141a';

/**
 * 解析应用图标路径。
 *
 * 打包后随 buildResources 进入 resources 目录；开发时直接读 build/icon.ico。
 * 一律找不到时返回 undefined：此时 Windows 会使用 exe 内嵌图标（由构建脚本写入），
 * 不会再去借用其它程序的图标。
 */
function resolveIconPath(): string | undefined {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'icon.ico') : '',
    path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    path.join(process.cwd(), 'build', 'icon.ico'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function createWindow(): void {
  const iconPath = resolveIconPath();
  const loaded = iconPath ? nativeImage.createFromPath(iconPath) : null;
  const windowIcon = loaded && !loaded.isEmpty() ? loaded : undefined;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 820,
    minHeight: 520,
    show: false,
    backgroundColor: WINDOW_BG,
    title: '深寻 SSH',
    autoHideMenuBar: false,
    // 显式指定窗口/任务栏图标，避免依赖系统猜测
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: PRELOAD_JS,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // WebGL 渲染器与部分 addon 需要访问原生 canvas 上下文
      spellcheck: false,
      backgroundThrottling: false, // 窗口失焦时保持终端刷新，避免 top 之类的程序卡顿
      v8CacheOptions: 'code',
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 窗口销毁前先清掉它的 SSH 连接，避免残留进程
  const wc = mainWindow.webContents;
  wc.on('destroyed', () => sessions.closeByWebContents(wc));

  /**
   * 渲染进程重新加载/崩溃时，它持有的终端标签会全部消失。
   * 若不在此处收尾，主进程会留下「没有任何界面可以操作」的僵尸 SSH 连接，
   * 表现为连接一直挂在服务器上直到超时。因此重载前先统一断开。
   */
  wc.on('did-start-navigation', (event) => {
    // 只处理真正的文档级导航（如 Ctrl+R 重载、开发者工具刷新）
    if (event.isSameDocument || event.isMainFrame === false) return;
    sessions.closeByWebContents(wc);
  });

  wc.on('render-process-gone', () => {
    sessions.closeByWebContents(wc);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });

  // 阻止渲染层被导航到外部地址（安全加固）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      void openExternal(url);
    }
  });

  void mainWindow.loadFile(RENDERER_HTML);

  if (isDev && process.env.DSH_SSH_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

async function openExternal(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      await shell.openExternal(url);
    }
  } catch {
    /* 非法 URL 直接忽略 */
  }
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件(&F)',
      submenu: [
        {
          label: '新建配置',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('menu:new-config'),
        },
        { type: 'separator' },
        {
          label: '重连当前标签',
          accelerator: 'CmdOrCtrl+R',
          click: () => send('menu:reconnect'),
        },
        {
          label: '断开当前标签',
          click: () => send('menu:disconnect'),
        },
        {
          label: '关闭当前标签',
          accelerator: 'CmdOrCtrl+W',
          click: () => send('menu:close-tab'),
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { label: '复制', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('menu:copy') },
        { label: '粘贴', accelerator: 'CmdOrCtrl+Shift+V', click: () => send('menu:paste') },
        { type: 'separator' },
        { label: '全选', click: () => send('menu:select-all') },
        { label: '查找', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('menu:find') },
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '放大字体', accelerator: 'CmdOrCtrl+Plus', click: () => send('menu:font-inc') },
        { label: '缩小字体', accelerator: 'CmdOrCtrl+-', click: () => send('menu:font-dec') },
        { label: '重置字体', accelerator: 'CmdOrCtrl+0', click: () => send('menu:font-reset') },
        { type: 'separator' },
        { label: '切换主题', click: () => send('menu:toggle-theme') },
        { label: '清屏', accelerator: 'CmdOrCtrl+K', click: () => send('menu:clear') },
        { type: 'separator' },
        { label: '重新加载界面', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大界面', role: 'zoomIn' },
        { label: '缩小界面', role: 'zoomOut' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '快捷键说明',
          click: () => send('menu:shortcuts'),
        },
        {
          label: '打开配置文件所在目录',
          click: () => {
            void shell.openPath(app.getPath('userData'));
          },
        },
        { type: 'separator' },
        {
          label: '关于 深寻 SSH',
          click: () => {
            if (!mainWindow) return;
            void dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: '深寻 SSH',
              detail:
                `版本 ${app.getVersion()}\n` +
                'Windows 桌面 SSH 客户端\n' +
                'Electron + xterm.js(WebGL) + ssh2\n\n' +
                '本软件不包含 SFTP / 端口转发 / 隧道功能。',
              buttons: ['确定'],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/* -------------------------------------------------------------------- */
/* IPC                                                                  */
/* -------------------------------------------------------------------- */

function registerIpc(): void {
  const store = getStore();

  /* --- 配置 --- */
  ipcMain.handle(IPC.configList, () => store.listConfigs());
  ipcMain.handle(IPC.configSave, (_e, config: Partial<SshConfig> & { name: string; host: string }) => {
    if (!config?.name?.trim()) throw new Error('配置名称不能为空');
    if (!config?.host?.trim()) throw new Error('主机地址不能为空');
    const port = Number(config.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535 之间的整数');
    return store.saveConfig({ ...config, name: config.name.trim(), host: config.host.trim(), port });
  });
  ipcMain.handle(IPC.configDelete, (_e, id: string) => store.deleteConfig(id));
  ipcMain.handle(IPC.configDuplicate, (_e, id: string) => store.duplicateConfig(id) ?? null);
  ipcMain.handle(IPC.configReorder, (_e, ids: string[]) => store.reorderConfigs(ids));

  /* --- 设置 --- */
  ipcMain.handle(IPC.settingsGet, () => store.getSettings());
  ipcMain.handle(IPC.settingsSave, (_e, patch: Partial<AppSettings>) => {
    const next = store.saveSettings(patch ?? {});
    nativeTheme.themeSource = next.theme === 'light' ? 'light' : 'dark';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(next.theme === 'light' ? '#f5f6f8' : WINDOW_BG);
    }
    return next;
  });
  ipcMain.handle('known-hosts:list', () => store.listKnownHosts());
  ipcMain.handle('known-hosts:forget', (_e, host: string, port: number) => {
    store.forgetHostKey(host, Number(port) || 22);
    return store.listKnownHosts();
  });

  /* --- 会话 --- */
  ipcMain.handle(IPC.sessionCreate, (e, configId: string, size: TermSize) =>
    sessions.create(String(configId), size ?? { cols: 80, rows: 24 }, e.sender),
  );
  ipcMain.handle(IPC.sessionWrite, (_e, sessionId: string, data: Uint8Array) => {
    sessions.write(String(sessionId), data);
  });
  ipcMain.handle(IPC.sessionResize, (_e, sessionId: string, size: TermSize) => {
    sessions.resize(String(sessionId), size);
  });
  ipcMain.handle(IPC.sessionClose, (_e, sessionId: string) => sessions.close(String(sessionId)));
  ipcMain.handle(IPC.sessionList, () => sessions.list());

  /* --- 其它 --- */
  ipcMain.handle(IPC.appIconPath, () => resolveIconPath() ?? null);
  ipcMain.handle(IPC.dialogPickKey, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择私钥文件',
      properties: ['openFile'],
      filters: [
        { name: '私钥文件', extensions: ['pem', 'key', 'ppk', 'openssh', 'rsa', 'ed25519'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
  ipcMain.handle(IPC.openExternal, (_e, url: string) => openExternal(String(url)));
}

/* -------------------------------------------------------------------- */
/* 生命周期                                                             */
/* -------------------------------------------------------------------- */

// 单实例：第二次启动时聚焦已有窗口，避免多份实例同时持有配置
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.setAppUserModelId('com.deepseek.ssh');

  void app.whenReady().then(() => {
    const store = getStore();
    const settings = store.getSettings();
    nativeTheme.themeSource = settings.theme === 'light' ? 'light' : 'dark';

    sessions = new SessionManager();
    registerIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    sessions?.closeAll();
    app.quit();
  });

  app.on('before-quit', () => {
    sessions?.closeAll();
  });
}
