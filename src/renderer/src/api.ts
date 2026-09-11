import type {
  AppSettings,
  SessionEndedEvent,
  SessionMeta,
  SessionStatusEvent,
  SshConfig,
  TermSize,
} from '../../main/types';

/** preload 暴露的终端数据通道句柄 */
export interface SessionChannel {
  post(message: unknown): void;
  close(): void;
  getStats(): { sent: number; received: number };
}

/** preload 通过 contextBridge 暴露到 window.dshSsh 的完整 API */
export interface DshSshBridge {
  listConfigs(): Promise<SshConfig[]>;
  saveConfig(config: Partial<SshConfig>): Promise<SshConfig>;
  deleteConfig(id: string): Promise<boolean>;
  duplicateConfig(id: string): Promise<SshConfig | null>;
  reorderConfigs(ids: string[]): Promise<SshConfig[]>;

  getSettings(): Promise<AppSettings>;
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  listKnownHosts(): Promise<Array<{ host: string; port: number; fingerprint: string }>>;
  forgetKnownHost(host: string, port: number): Promise<Array<{ host: string; port: number; fingerprint: string }>>;

  createSession(configId: string, size: TermSize): Promise<{ ok: boolean; sessionId?: string; error?: string }>;
  writeSession(sessionId: string, data: Uint8Array): Promise<void>;
  resizeSession(sessionId: string, size: TermSize): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(): Promise<SessionMeta[]>;

  onSessionStatus(listener: (event: SessionStatusEvent) => void): () => void;
  onSessionEnded(listener: (event: SessionEndedEvent) => void): () => void;
  onMenuCommand(listener: (command: string) => void): () => void;

  /** 建立终端数据专用通道，onMessage 在 preload 世界内直接回调 */
  createSessionChannel(sessionId: string, onMessage: (data: unknown) => void): SessionChannel;

  pickPrivateKey(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  /** 主进程实际解析到的应用图标路径（null 表示回退到 exe 内嵌图标） */
  getIconPath(): Promise<string | null>;
  readClipboardText(): string;
  writeClipboardText(text: string): void;
}

declare global {
  interface Window {
    dshSsh: DshSshBridge;
  }
}

export const api: DshSshBridge = window.dshSsh;
