import type { AppSettings, SessionStatus, SshConfig } from '../../main/types';
import { bindContextMenu, type ContextMenuItem } from './context-menu';
import { openConfigDialog, openConfigInfoDialog } from './config-dialog';
import { confirmDialog } from './dialogs';
import { toast } from './toast';
import { formatTime } from './util';

export interface SidebarCallbacks {
  onConnect(config: SshConfig): void;
  onEdit(config: SshConfig): void;
  /** 新建配置（保存后由调用方决定是否连接，统一走 createAndConnect） */
  onNewConfig(): void;
  onDuplicated(): void;
  onDeleted(id: string): void;
  onSelectionChange(config: SshConfig | null): void;
  /** 配置被新建 / 修改 / 删除后，刷新列表 */
  onSaved(): Promise<void> | void;
  /** 右键菜单中断开某配置的所有会话 */
  onDisconnectConfig?(config: SshConfig): void;
}

interface Row {
  root: HTMLElement;
  badge: HTMLElement;
  config: SshConfig;
}

/**
 * 左侧服务器配置列表。
 * 支持搜索过滤、右键菜单（连接/编辑/复制/删除/详情）、新建按钮、双击连接。
 */
export class Sidebar {
  private rows = new Map<string, Row>();
  private configs: SshConfig[] = [];
  private selectedId: string | null = null;
  private filter = '';
  /** configId -> 当前是否有活动会话 */
  private active = new Map<string, SessionStatus>();

  constructor(
    private listEl: HTMLElement,
    private searchEl: HTMLInputElement,
    private newButton: HTMLElement,
    private callbacks: SidebarCallbacks,
  ) {
    // 「＋ 新建」与首页的「新建第一个配置」保持一致：保存后立即连接。
    // 之前这里只保存不连接，导致保存成功却没有任何终端出现，容易被误认为「没反应」。
    this.newButton.addEventListener('click', () => this.callbacks.onNewConfig());
    this.searchEl.addEventListener('input', () => {
      this.filter = this.searchEl.value.trim().toLowerCase();
      this.render();
    });
    this.searchEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.searchEl.value = '';
        this.filter = '';
        this.render();
      }
      // 在搜索框按方向键可切换选择
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      }
      if (event.key === 'Enter') {
        const config = this.selectedConfig;
        if (config) this.callbacks.onConnect(config);
      }
    });

    // 列表空白处的右键：提供新建入口
    bindContextMenu(this.listEl, (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('.config-item');
      if (target) {
        const id = target.dataset.id;
        const config = this.configs.find((c) => c.id === id);
        return config ? this.buildMenu(config) : null;
      }
      return [{ label: '新建配置', key: 'Ctrl+N', onClick: () => this.callbacks.onNewConfig() }];
    });

    this.listEl.addEventListener('keydown', (event) => this.onListKeyDown(event));
  }

  get selectedConfig(): SshConfig | null {
    return this.configs.find((c) => c.id === this.selectedId) ?? null;
  }

  /* ------------------------------------------------------------------ */

  setConfigs(configs: SshConfig[]): void {
    this.configs = configs;
    // 保持选中项有效
    if (this.selectedId && !configs.some((c) => c.id === this.selectedId)) {
      this.selectedId = configs[0]?.id ?? null;
    }
    if (!this.selectedId && configs.length) this.selectedId = configs[0].id;
    this.render();
    this.callbacks.onSelectionChange(this.selectedConfig);
  }

  /** 标记某个配置是否有活动会话（用于列表右侧绿点） */
  setActive(configId: string, status: SessionStatus | null): void {
    if (status) this.active.set(configId, status);
    else this.active.delete(configId);
    const row = this.rows.get(configId);
    if (!row) return;
    const current = this.active.get(configId);
    row.root.classList.toggle('active-session', current === 'connected' || current === 'connecting');
    row.badge.textContent = current ? statusLabel(current) : '';
    row.badge.classList.toggle('hidden', !current);
  }

  select(configId: string | null): void {
    this.selectedId = configId;
    for (const [id, row] of this.rows) row.root.classList.toggle('selected', id === configId);
    this.callbacks.onSelectionChange(this.selectedConfig);
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  render(): void {
    const keyword = this.filter;
    const visible = this.configs.filter((c) => {
      if (!keyword) return true;
      return (
        c.name.toLowerCase().includes(keyword) ||
        c.host.toLowerCase().includes(keyword) ||
        (c.username ?? '').toLowerCase().includes(keyword) ||
        String(c.port).includes(keyword)
      );
    });

    this.listEl.textContent = '';
    this.rows.clear();

    if (!this.configs.length) {
      this.listEl.appendChild(
        this.buildEmpty('还没有任何配置\n点击上方「＋ 新建」添加第一台服务器'),
      );
      return;
    }
    if (!visible.length) {
      this.listEl.appendChild(this.buildEmpty(`没有匹配「${this.searchEl.value}」的配置`));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const config of visible) {
      const { root, badge } = this.buildRow(config);
      this.rows.set(config.id, { root, badge, config });
      fragment.appendChild(root);
    }
    this.listEl.appendChild(fragment);

    // 恢复选中样式与活动标记
    for (const [id, row] of this.rows) {
      row.root.classList.toggle('selected', id === this.selectedId);
      const status = this.active.get(id);
      row.root.classList.toggle('active-session', status === 'connected' || status === 'connecting');
      if (status) {
        row.badge.textContent = statusLabel(status);
        row.badge.classList.remove('hidden');
      }
    }
  }

  private buildEmpty(text: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'config-empty';
    node.textContent = text;
    node.style.whiteSpace = 'pre-line';
    return node;
  }

  private buildRow(config: SshConfig): { root: HTMLElement; badge: HTMLElement } {
    const root = document.createElement('div');
    root.className = 'config-item';
    root.dataset.id = config.id;
    root.tabIndex = 0;
    root.title = [
      `${config.username ? config.username + '@' : ''}${config.host}:${config.port}`,
      config.note ? `备注：${config.note}` : '',
      `最近连接：${formatTime(config.lastUsedAt)}`,
      '',
      '双击连接 · 右键更多操作',
    ]
      .filter(Boolean)
      .join('\n');

    const icon = document.createElement('div');
    icon.className = 'config-icon';
    icon.textContent = (config.name.trim()[0] ?? 'S').toUpperCase();

    const meta = document.createElement('div');
    meta.className = 'config-meta';

    const name = document.createElement('div');
    name.className = 'config-name';
    name.textContent = config.name;

    const sub = document.createElement('div');
    sub.className = 'config-sub';
    sub.textContent = `${config.username ? config.username + '@' : ''}${config.host}:${config.port}`;

    meta.appendChild(name);
    meta.appendChild(sub);

    const badge = document.createElement('span');
    badge.className = 'tab-badge hidden';

    root.appendChild(icon);
    root.appendChild(meta);
    root.appendChild(badge);

    const status = this.active.get(config.id);
    if (status) {
      badge.textContent = statusLabel(status);
      badge.classList.remove('hidden');
      root.classList.add('active-session');
    }

    root.addEventListener('mousedown', () => this.select(config.id));
    root.addEventListener('dblclick', () => this.callbacks.onConnect(config));
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.callbacks.onConnect(config);
      }
    });

    return { root, badge };
  }

  /* ------------------------------------------------------------------ */
  /* 交互                                                                */
  /* ------------------------------------------------------------------ */

  private onListKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      const config = this.selectedConfig;
      if (config) this.callbacks.onConnect(config);
    }
  }

  private moveSelection(delta: number): void {
    const visible = this.visibleConfigs();
    if (!visible.length) return;
    const currentIndex = visible.findIndex((c) => c.id === this.selectedId);
    const nextIndex = Math.min(visible.length - 1, Math.max(0, currentIndex + delta));
    const next = visible[nextIndex] ?? visible[0];
    this.select(next.id);
    this.rows.get(next.id)?.root.scrollIntoView({ block: 'nearest' });
  }

  private visibleConfigs(): SshConfig[] {
    const keyword = this.filter;
    if (!keyword) return this.configs;
    return this.configs.filter(
      (c) =>
        c.name.toLowerCase().includes(keyword) ||
        c.host.toLowerCase().includes(keyword) ||
        (c.username ?? '').toLowerCase().includes(keyword),
    );
  }

  private buildMenu(config: SshConfig): ContextMenuItem[] {
    const status = this.active.get(config.id);
    const connected = status === 'connected' || status === 'connecting';
    return [
      { label: '连接', key: '双击', onClick: () => this.callbacks.onConnect(config) },
      {
        label: '断开连接',
        disabled: !connected,
        onClick: () => this.callbacks.onDisconnectConfig?.(config),
      },
      { separator: true },
      { label: '编辑…', onClick: () => this.callbacks.onEdit(config) },
      { label: '复制配置', onClick: () => void this.duplicate(config.id) },
      { separator: true },
      { label: '查看详情', onClick: () => openConfigInfoDialog(config) },
      {
        label: '复制连接命令',
        onClick: async () => {
          const cmd = `ssh ${config.username ? config.username + '@' : ''}${config.host} -p ${config.port}`;
          try {
            await navigator.clipboard.writeText(cmd);
            toast('已复制：' + cmd, 'ok');
          } catch {
            toast('复制失败', 'err');
          }
        },
      },
      { separator: true },
      {
        label: '删除配置',
        danger: true,
        onClick: () => void this.remove(config),
      },
    ];
  }

  /** 新建配置并保存；保存成功后由调用方决定是否连接 */
  async createConfig(): Promise<SshConfig | null> {
    const saved = await openConfigDialog();
    if (!saved) return null;
    toast(`配置「${saved.name}」已保存`, 'ok');
    await this.callbacks.onSaved?.();
    return saved;
  }

  async editConfig(config: SshConfig): Promise<SshConfig | null> {
    const saved = await openConfigDialog(config);
    if (!saved) return null;
    toast(`配置「${saved.name}」已更新`, 'ok');
    await this.callbacks.onSaved?.();
    return saved;
  }

  private async duplicate(id: string): Promise<void> {
    const copy = await window.dshSsh.duplicateConfig(id);
    if (!copy) {
      toast('复制失败：配置不存在', 'err');
      return;
    }
    toast(`已复制为「${copy.name}」`, 'ok');
    await this.callbacks.onSaved?.();
  }

  private async remove(config: SshConfig): Promise<void> {
    const ok = await confirmDialog({
      title: '删除配置',
      message: `确定要删除配置「${config.name}」吗？`,
      detail: '该操作不会断开已经建立的连接，但会同时删除已保存的密码。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    const removed = await window.dshSsh.deleteConfig(config.id);
    if (!removed) {
      toast('删除失败：配置不存在', 'err');
      return;
    }
    toast(`配置「${config.name}」已删除`, 'ok');
    this.callbacks.onDeleted(config.id);
    await this.callbacks.onSaved?.();
  }
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'connecting':
      return '连接中';
    case 'connected':
      return '已连接';
    case 'disconnected':
      return '已断开';
    case 'error':
      return '错误';
    default:
      return '';
  }
}
