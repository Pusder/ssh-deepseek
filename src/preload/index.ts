import { contextBridge, clipboard, ipcRenderer } from 'electron';
import { IPC } from '../main/ipc';
import type {
  AppSettings,
  SessionEndedEvent,
  SessionMeta,
  SessionStatusEvent,
  SshConfig,
  TermSize,
} from '../main/types';

type StatusListener = (event: SessionStatusEvent) => void;
type EndedListener = (event: SessionEndedEvent) => void;

/** 普通的请求-响应式 API（走 ipcRenderer.invoke） */
const api = {
  /* ---------------- 配置 ---------------- */
  listConfigs: (): Promise<SshConfig[]> => ipcRenderer.invoke(IPC.configList),
  saveConfig: (config: Partial<SshConfig>): Promise<SshConfig> => ipcRenderer.invoke(IPC.configSave, config),
  deleteConfig: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.configDelete, id),
  duplicateConfig: (id: string): Promise<SshConfig | null> => ipcRenderer.invoke(IPC.configDuplicate, id),
  reorderConfigs: (ids: string[]): Promise<SshConfig[]> => ipcRenderer.invoke(IPC.configReorder, ids),

  /* ---------------- 设置 ---------------- */
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsSave, patch),
  listKnownHosts: (): Promise<Array<{ host: string; port: number; fingerprint: string }>> =>
    ipcRenderer.invoke('known-hosts:list'),
  forgetKnownHost: (host: string, port: number) =>
    ipcRenderer.invoke('known-hosts:forget', host, port),

  /* ---------------- 会话 ---------------- */
  createSession: (configId: string, size: TermSize): Promise<{ ok: boolean; sessionId?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.sessionCreate, configId, size),
  writeSession: (sessionId: string, data: Uint8Array): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionWrite, sessionId, data),
  resizeSession: (sessionId: string, size: TermSize): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionResize, sessionId, size),
  closeSession: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.sessionClose, sessionId),
  listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke(IPC.sessionList),

  /* ---------------- 事件订阅 ---------------- */
  onSessionStatus: (listener: StatusListener): (() => void) => {
    const wrapped = (_e: unknown, payload: SessionStatusEvent) => listener(payload);
    ipcRenderer.on(IPC.sessionStatus, wrapped);
    return () => ipcRenderer.removeListener(IPC.sessionStatus, wrapped);
  },
  onSessionEnded: (listener: EndedListener): (() => void) => {
    const wrapped = (_e: unknown, payload: SessionEndedEvent) => listener(payload);
    ipcRenderer.on(IPC.sessionEnded, wrapped);
    return () => ipcRenderer.removeListener(IPC.sessionEnded, wrapped);
  },

  /* ---------------- 主进程菜单转发 ---------------- */
  onMenuCommand: (listener: (command: string) => void): (() => void) => {
    const channels = [
      'menu:new-config',
      'menu:reconnect',
      'menu:disconnect',
      'menu:close-tab',
      'menu:copy',
      'menu:paste',
      'menu:select-all',
      'menu:find',
      'menu:font-inc',
      'menu:font-dec',
      'menu:font-reset',
      'menu:toggle-theme',
      'menu:clear',
      'menu:shortcuts',
    ];
    const wrappers = channels.map((ch) => {
      const fn = () => listener(ch);
      ipcRenderer.on(ch, fn);
      return [ch, fn] as const;
    });
    return () => {
      for (const [ch, fn] of wrappers) ipcRenderer.removeListener(ch, fn);
    };
  },

  /* ---------------- 其它 ---------------- */
  pickPrivateKey: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickKey),
  /** 主进程实际解析到的应用图标路径（null 表示未找到，将回退到 exe 内嵌图标） */
  getIconPath: (): Promise<string | null> => ipcRenderer.invoke(IPC.appIconPath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
  /** 用系统文件管理器打开本地目录；返回空串表示成功，否则为错误文案 */
  openPath: (path: string): Promise<string> => ipcRenderer.invoke(IPC.appOpenPath, path),
  /** 主进程剪贴板兜底：navigator.clipboard 不可用时使用 */
  readClipboardText: (): string => clipboard.readText(),
  writeClipboardText: (text: string): void => clipboard.writeText(text),
};

/**
 * 终端数据通道。
 *
 * MessagePort 实例无法穿过 contextBridge 的隔离世界边界，因此在 preload 世界内
 * 完成端口绑定，只向渲染层暴露 post / close 两个方法，接收回调也在 preload 侧直接触发。
 * 数据以 Buffer -> ArrayBuffer 的二进制形式传递，渲染层拿到 Uint8Array 后
 * 可原样交给 term.write()，完全跳过 UTF-8 字符串解码，这是高频输出流畅的关键。
 */
function createSessionChannel(sessionId: string, onMessage: (data: unknown) => void) {
  let port: MessagePort | null = null;
  let sentFrames = 0;
  let receivedFrames = 0;
  /** 端口交付前积压的消息（连接早期的输入与尺寸调整） */
  const queued: unknown[] = [];

  // 主进程在会话创建时就已持有通道一端，这里只等它把对端交付过来
  const waitPort = (event: Electron.IpcRendererEvent, payload: { sessionId?: string }) => {
    if (payload?.sessionId && payload.sessionId !== sessionId) return;
    const delivered = event.ports?.[0];
    if (!delivered) {
      console.warn('[preload] 收到端口消息但没有 MessagePort');
      return;
    }
    ipcRenderer.removeListener(IPC.sessionPort, waitPort);
    port = delivered;
    port.onmessage = (messageEvent: MessageEvent) => {
      receivedFrames++;
      onMessage(messageEvent.data);
    };
    port.start();
    // 端口就绪后按顺序补发此前积压的消息，确保早期输入/尺寸不丢
    for (const message of queued) {
      try {
        port.postMessage(message);
        sentFrames++;
      } catch (err) {
        console.warn('[preload] 补发消息失败', err);
      }
    }
    queued.length = 0;
    console.info(`[preload] 终端数据通道已建立 session=${sessionId}`);
  };
  ipcRenderer.on(IPC.sessionPort, waitPort);

  // 向主进程索取该会话的通道对端端口
  ipcRenderer.send(IPC.sessionReady, { sessionId });

  return {
    /** 发送消息到主进程（端口未就绪时先入队，就绪后按序补发） */
    post(message: unknown): void {
      if (!port) {
        if (queued.length < 128) queued.push(message);
        return;
      }
      try {
        sentFrames++;
        port.postMessage(message);
      } catch (err) {
        console.warn('[preload] 向主进程发送数据失败', err);
      }
    },
    close(): void {
      ipcRenderer.removeListener(IPC.sessionPort, waitPort);
      try {
        if (port) {
          port.onmessage = null;
          port.close();
        }
      } catch {
        /* ignore */
      }
    },
    getStats: () => ({ sent: sentFrames, received: receivedFrames }),
  };
}

const bridge = { ...api, createSessionChannel };

contextBridge.exposeInMainWorld('dshSsh', bridge);

export type DshSshApi = typeof bridge;
