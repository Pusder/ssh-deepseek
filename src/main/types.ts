/** 主进程 / 渲染进程共享的数据结构定义 */

/** 一条可保存的服务器连接配置 */
export interface SshConfig {
  /** 唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 主机地址（IP 或域名） */
  host: string;
  /** 端口，默认 22 */
  port: number;
  /** 登录用户名 */
  username: string;
  /** 明文密码：仅在渲染进程与主进程内存中短暂存在，落盘时由 safeStorage 加密 */
  password?: string;
  /** 是否记住密码 */
  savePassword: boolean;
  /** 私钥文件路径（可选，留空则使用密码认证） */
  privateKeyPath?: string;
  /** 私钥口令（可选） */
  passphrase?: string;
  /** 备注 */
  note?: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 最近连接时间戳 */
  lastUsedAt?: number;
}

/** 持久化到磁盘的存储结构 */
export interface StoreShape {
  version: number;
  configs: PersistedSshConfig[];
  settings: AppSettings;
  /** 已信任的主机指纹：key = `${host}:${port}` */
  knownHosts: Record<string, string>;
  /** 运行时缓存（不落盘） */
  __runtime?: never;
}

/** 落盘形态：密码为 safeStorage 加密后的 base64 字符串 */
export interface PersistedSshConfig extends Omit<SshConfig, 'password'> {
  /** 加密后的密码（base64），无法加密时降级为 `plain:` 前缀的明文 */
  passwordEnc?: string;
}

/** 应用设置 */
export interface AppSettings {
  /** 终端字体族 */
  fontFamily: string;
  /** 字号（px） */
  fontSize: number;
  /** 行高倍数 */
  lineHeight: number;
  /** 主题名 */
  theme: string;
  /** 回看行数 */
  scrollback: number;
  /** 光标样式 */
  cursorStyle: 'block' | 'underline' | 'bar';
  /** 光标闪烁 */
  cursorBlink: boolean;
  /** 失去焦点时是否仍发送输入 */
  keepAliveOnBlur: boolean;
  /** SSH 传输层：内置 ssh2 库（默认）或调用系统 ssh.exe（公司管控软件可能只放行系统客户端） */
  transport: 'ssh2' | 'systemSsh';
  /** 左侧边栏是否折叠 */
  sidebarCollapsed: boolean;
  /** 右侧工具面板（项目导航 / 编译命令）是否显示 */
  showToolsPanel: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily:
    "'Cascadia Mono', 'Cascadia Code', Consolas, 'JetBrains Mono', 'Sarasa Mono SC', 'Microsoft YaHei Mono', 'Courier New', monospace",
  fontSize: 15,
  lineHeight: 1.2,
  theme: 'dark',
  scrollback: 20000,
  cursorStyle: 'bar',
  cursorBlink: true,
  keepAliveOnBlur: false,
  transport: 'ssh2',
  sidebarCollapsed: false,
  showToolsPanel: true,
};

/** 会话状态 */
export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** 终端尺寸 */
export interface TermSize {
  cols: number;
  rows: number;
}

/** 会话元信息（列表用） */
export interface SessionMeta {
  sessionId: string;
  configId: string;
  title: string;
  host: string;
  port: number;
  username: string;
  status: SessionStatus;
  startedAt: number;
}

/** 主进程 -> 渲染进程：会话状态变化 */
export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  message?: string;
}

/** 主进程 -> 渲染进程：会话结束 */
export interface SessionEndedEvent {
  sessionId: string;
  /** 人类可读的结束原因（中文） */
  reason: string;
  /** 是否为正常断开 */
  clean: boolean;
}

/** 通过 MessagePort 传递的消息协议 */
export interface PortBootstrapMessage {
  type: 'bootstrap';
  sessionId: string;
  config: {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
  };
  status: SessionStatus;
}

export type PortOutgoingMessage = PortBootstrapMessage;

export type PortIncomingMessage =
  | { type: 'write'; data: Uint8Array }
  | { type: 'resize'; size: TermSize }
  | { type: 'disconnect' };
