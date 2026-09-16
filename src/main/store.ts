import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AppSettings,
  DEFAULT_SETTINGS,
  PersistedSshConfig,
  SshConfig,
  StoreShape,
} from './types';

const STORE_VERSION = 1;
const PLAIN_PREFIX = 'plain:';

/**
 * 本地配置存储。
 *
 * 设计取舍：不使用 electron-store（v10 起为 ESM-only，与 CJS 主进程互操作成本高），
 * 改为自研等价实现，行为完全可控：单文件 JSON + 原子写入 + 内存缓存。
 *
 * 密码安全：优先使用 Electron safeStorage（Windows 下为 DPAPI，绑定当前用户账户），
 * 加密后以 base64 落盘；若系统不支持加密（safeStorage.isEncryptionAvailable() === false），
 * 则以 `plain:` 前缀降级保存并在日志中警告，绝不会静默丢失用户密码。
 */
class ConfigStore {
  private filePath: string;
  private data: StoreShape;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'deepseek-ssh-store.json');
    this.data = this.load();
  }

  /* ------------------------------------------------------------------ */
  /* 读写                                                                */
  /* ------------------------------------------------------------------ */

  private defaults(): StoreShape {
    return {
      version: STORE_VERSION,
      configs: [],
      settings: { ...DEFAULT_SETTINGS },
      knownHosts: {},
    };
  }

  private load(): StoreShape {
    try {
      if (!fs.existsSync(this.filePath)) return this.defaults();
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      return {
        version: STORE_VERSION,
        configs: Array.isArray(parsed.configs) ? parsed.configs : [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
        knownHosts:
          parsed.knownHosts && typeof parsed.knownHosts === 'object' ? parsed.knownHosts : {},
      };
    } catch (err) {
      // 文件损坏：备份后重建，避免用户数据被静默覆盖
      try {
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.filePath, backup);
        console.error('[store] 配置文件解析失败，已备份至', backup, err);
      } catch {
        /* ignore */
      }
      return this.defaults();
    }
  }

  /** 立即同步落盘（原子写入：先写临时文件再 rename） */
  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[store] 写入配置失败', err);
    }
  }

  /** 合并 60ms 内的多次写入，避免频繁磁盘 IO */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 60);
  }

  /* ------------------------------------------------------------------ */
  /* 密码加解密                                                          */
  /* ------------------------------------------------------------------ */

  private encryptSecret(plain: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.encryptString(plain).toString('base64');
      } catch (err) {
        console.error('[store] safeStorage 加密失败，降级为明文保存', err);
      }
    }
    return PLAIN_PREFIX + Buffer.from(plain, 'utf8').toString('base64');
  }

  private decryptSecret(stored: string | undefined): string | undefined {
    if (!stored) return undefined;
    if (stored.startsWith(PLAIN_PREFIX)) {
      try {
        return Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8');
      } catch {
        return undefined;
      }
    }
    try {
      if (!safeStorage.isEncryptionAvailable()) return undefined;
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch (err) {
      // 换机器 / 换用户后 DPAPI 无法解密，视为无密码
      console.warn('[store] 密码解密失败（可能更换了系统账户）', err);
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 配置 CRUD                                                           */
  /* ------------------------------------------------------------------ */

  private toPublic(p: PersistedSshConfig): SshConfig {
    const { passwordEnc, ...rest } = p;
    const password = this.decryptSecret(passwordEnc);
    return {
      ...rest,
      savePassword: !!rest.savePassword,
      password: rest.savePassword ? password : undefined,
    };
  }

  private toPersisted(c: SshConfig): PersistedSshConfig {
    const { password, ...rest } = c;
    const persist: PersistedSshConfig = { ...rest, savePassword: !!c.savePassword };
    if (c.savePassword && password) {
      persist.passwordEnc = this.encryptSecret(password);
    }
    return persist;
  }

  listConfigs(): SshConfig[] {
    return this.data.configs.map((c) => this.toPublic(c));
  }

  getConfig(id: string): SshConfig | undefined {
    const found = this.data.configs.find((c) => c.id === id);
    return found ? this.toPublic(found) : undefined;
  }

  /** 保存（新增或更新），返回保存后的配置 */
  saveConfig(input: Partial<SshConfig> & { name: string; host: string }): SshConfig {
    const now = Date.now();
    const idx = input.id ? this.data.configs.findIndex((c) => c.id === input.id) : -1;

    if (idx >= 0) {
      const prev = this.data.configs[idx];
      const merged: SshConfig = {
        ...this.toPublic(prev),
        ...input,
        id: prev.id,
        createdAt: prev.createdAt,
        lastUsedAt: prev.lastUsedAt,
      } as SshConfig;
      // 用户关闭“记住密码”时彻底清除已存密码
      if (!merged.savePassword) delete merged.password;
      this.data.configs[idx] = this.toPersisted(merged);
      this.flush();
      return this.toPublic(this.data.configs[idx]);
    }

    const fresh: SshConfig = {
      id: input.id || randomUUID(),
      name: input.name,
      host: input.host,
      port: input.port && input.port > 0 ? input.port : 22,
      username: input.username ?? '',
      password: input.password,
      savePassword: !!input.savePassword,
      privateKeyPath: input.privateKeyPath,
      passphrase: input.passphrase,
      note: input.note,
      createdAt: now,
    };
    this.data.configs.push(this.toPersisted(fresh));
    this.flush();
    return this.toPublic(this.data.configs[this.data.configs.length - 1]);
  }

  deleteConfig(id: string): boolean {
    const before = this.data.configs.length;
    this.data.configs = this.data.configs.filter((c) => c.id !== id);
    const changed = this.data.configs.length !== before;
    if (changed) this.flush();
    return changed;
  }

  duplicateConfig(id: string): SshConfig | undefined {
    const src = this.data.configs.find((c) => c.id === id);
    if (!src) return undefined;
    const copy: PersistedSshConfig = {
      ...src,
      id: randomUUID(),
      name: `${src.name} - 副本`,
      createdAt: Date.now(),
      lastUsedAt: undefined,
    };
    const at = this.data.configs.findIndex((c) => c.id === id);
    this.data.configs.splice(at + 1, 0, copy);
    this.flush();
    return this.toPublic(copy);
  }

  /** 记录一次成功连接时间 */
  touchConfig(id: string): void {
    const found = this.data.configs.find((c) => c.id === id);
    if (!found) return;
    found.lastUsedAt = Date.now();
    this.scheduleFlush();
  }

  reorderConfigs(orderedIds: string[]): SshConfig[] {
    const map = new Map(this.data.configs.map((c) => [c.id, c]));
    const next: PersistedSshConfig[] = [];
    for (const id of orderedIds) {
      const item = map.get(id);
      if (item) {
        next.push(item);
        map.delete(id);
      }
    }
    // 未出现在列表中的（理论上不会）追加到末尾，防止数据丢失
    for (const item of map.values()) next.push(item);
    this.data.configs = next;
    this.flush();
    return this.listConfigs();
  }

  /* ------------------------------------------------------------------ */
  /* 设置                                                                */
  /* ------------------------------------------------------------------ */

  getSettings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...this.data.settings };
  }

  saveSettings(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = { ...this.getSettings(), ...patch };
    // 基本边界保护
    next.fontSize = Math.min(40, Math.max(8, Math.round(next.fontSize)));
    next.lineHeight = Math.min(2, Math.max(1, next.lineHeight));
    next.scrollback = Math.min(200000, Math.max(500, Math.round(next.scrollback)));
    if (next.transport !== 'systemSsh') next.transport = 'ssh2';
    next.sidebarCollapsed = !!next.sidebarCollapsed;
    next.showToolsPanel = !!next.showToolsPanel;
    this.data.settings = next;
    this.scheduleFlush();
    return next;
  }

  /* ------------------------------------------------------------------ */
  /* 主机密钥指纹                                                        */
  /* ------------------------------------------------------------------ */

  private hostKey(host: string, port: number): string {
    return `${host}:${port}`;
  }

  /** 校验主机指纹。返回值 kept=true 表示可以继续连接 */
  verifyHostKey(host: string, port: number, fingerprint: string): { kept: boolean; firstTime: boolean } {
    const key = this.hostKey(host, port);
    const known = this.data.knownHosts[key];
    if (!known) {
      this.data.knownHosts[key] = fingerprint;
      this.flush();
      return { kept: true, firstTime: true };
    }
    return { kept: known === fingerprint, firstTime: false };
  }

  forgetHostKey(host: string, port: number): void {
    delete this.data.knownHosts[this.hostKey(host, port)];
    this.flush();
  }

  /** 供设置面板展示用 */
  listKnownHosts(): Array<{ host: string; port: number; fingerprint: string }> {
    return Object.entries(this.data.knownHosts).map(([key, fingerprint]) => {
      const i = key.lastIndexOf(':');
      return {
        host: key.slice(0, i),
        port: Number(key.slice(i + 1)) || 22,
        fingerprint,
      };
    });
  }
}

let instance: ConfigStore | null = null;

export function getStore(): ConfigStore {
  if (!instance) instance = new ConfigStore();
  return instance;
}

export type { ConfigStore };
