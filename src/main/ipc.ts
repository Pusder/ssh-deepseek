/**
 * 主进程 <-> 渲染进程通道常量。
 * 该文件同时被 main / preload / renderer 引用，因此不能包含任何 Node 或 DOM 专有 API。
 */
export const IPC = {
  /* ---- 配置管理（ipcRenderer.invoke，请求-响应语义） ---- */
  configList: 'config:list',
  configSave: 'config:save',
  configDelete: 'config:delete',
  configDuplicate: 'config:duplicate',
  configReorder: 'config:reorder',

  /* ---- 应用设置 ---- */
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',

  /* ---- 私钥文件选择 ---- */
  dialogPickKey: 'dialog:pick-key',

  /* ---- 会话控制（invoke） ---- */
  sessionCreate: 'session:create',
  sessionWrite: 'session:write',
  sessionResize: 'session:resize',
  sessionClose: 'session:close',
  sessionList: 'session:list',

  /* ---- 会话事件（主进程 -> 渲染进程，均为 ipcRenderer.on 的轻量元事件） ---- */
  sessionStatus: 'session:status',
  sessionEnded: 'session:ended',
  sessionRemoteResize: 'session:remote-resize',

  /* ---- 终端数据通道（MessagePort 二进制直传，不经 ipcMain.handle） ---- */
  /** 渲染进程请求为其会话建立数据通道（渲染进程 -> 主进程） */
  sessionReady: 'session:ready',
  /** 主进程把数据通道端口投递给渲染进程（主进程 -> 渲染进程） */
  sessionPort: 'session:port',

  /* ---- 其它 ---- */
  openExternal: 'app:open-external',
  appThemeSync: 'app:theme-sync',
  /** 主进程实际加载的应用图标路径（用于确认图标资源可用） */
  appIconPath: 'app:icon-path',
} as const;

/** 会话创建结果 */
export interface CreateSessionResult {
  sessionId?: string;
  ok: boolean;
  error?: string;
}
