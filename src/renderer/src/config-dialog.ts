import type { AppSettings, SshConfig } from '../../main/types';
import { api } from './api';
import { openModal } from './dialogs';
import { THEMES, THEME_ORDER } from './themes';
import { el, formatTime } from './util';

/* ===================================================================== */
/* 配置编辑对话框                                                         */
/* ===================================================================== */

interface FormFields {
  name: HTMLInputElement;
  host: HTMLInputElement;
  port: HTMLInputElement;
  username: HTMLInputElement;
  password: HTMLInputElement;
  showPassword: HTMLInputElement;
  savePassword: HTMLInputElement;
  privateKeyPath: HTMLInputElement;
  passphrase: HTMLInputElement;
  note: HTMLInputElement;
}

function textField(
  label: string,
  input: HTMLInputElement | HTMLSelectElement,
  hint?: string,
  wrapper?: HTMLElement,
): HTMLElement {
  return el('div', {
    className: 'field',
    children: [
      el('label', { text: label }),
      wrapper ?? input,
      hint ? el('span', { className: 'hint', text: hint }) : null,
    ],
  });
}

/**
 * 新建 / 编辑服务器配置。
 * 密码在渲染进程以明文存在，仅在保存时交给主进程用 safeStorage 加密落盘。
 */
export function openConfigDialog(existing?: SshConfig): Promise<SshConfig | null> {
  return new Promise((resolve) => {
    const isEdit = !!existing;

    const nameInput = el('input', { attrs: { type: 'text', placeholder: '例如：生产 Web 服务器' } });
    const hostInput = el('input', { attrs: { type: 'text', placeholder: '192.168.1.10 或 example.com', spellcheck: 'false' } });
    const portInput = el('input', { attrs: { type: 'number', min: '1', max: '65535', placeholder: '22' } });
    const userInput = el('input', { attrs: { type: 'text', placeholder: 'root', spellcheck: 'false' } });
    const passInput = el('input', { attrs: { type: 'password', placeholder: '留空表示连接时手动输入或使用私钥' } });
    const showPassword = el('input', { attrs: { type: 'checkbox' } });
    const savePassword = el('input', { attrs: { type: 'checkbox' } });
    const keyInput = el('input', { attrs: { type: 'text', placeholder: '可选：OpenSSH 格式私钥路径', spellcheck: 'false' } });
    const passphraseInput = el('input', { attrs: { type: 'password', placeholder: '私钥口令（无私钥口令可留空）' } });
    const noteInput = el('input', { attrs: { type: 'text', placeholder: '可选备注' } });

    const browseBtn = el('button', { className: 'btn', text: '浏览…', title: '选择私钥文件' });
    browseBtn.addEventListener('click', async () => {
      const picked = await api.pickPrivateKey();
      if (picked) keyInput.value = picked;
    });

    showPassword.addEventListener('change', () => {
      passInput.type = showPassword.checked ? 'text' : 'password';
    });

    const fields: FormFields = {
      name: nameInput,
      host: hostInput,
      port: portInput,
      username: userInput,
      password: passInput,
      showPassword,
      savePassword,
      privateKeyPath: keyInput,
      passphrase: passphraseInput,
      note: noteInput,
    };

    // 初值
    if (existing) {
      nameInput.value = existing.name ?? '';
      hostInput.value = existing.host ?? '';
      portInput.value = String(existing.port ?? 22);
      userInput.value = existing.username ?? '';
      passInput.value = existing.password ?? '';
      savePassword.checked = !!existing.savePassword;
      keyInput.value = existing.privateKeyPath ?? '';
      passphraseInput.value = existing.passphrase ?? '';
      noteInput.value = existing.note ?? '';
    } else {
      portInput.value = '22';
      savePassword.checked = true;
      userInput.value = 'root';
    }

    const modal = openModal({
      title: isEdit ? '编辑配置' : '新建配置',
      buttons: [
        { label: '取消' },
        {
          label: isEdit ? '保存' : '保存并连接',
          variant: 'primary',
          autofocus: true,
          onClick: async () => {
            const name = nameInput.value.trim();
            const host = hostInput.value.trim();
            const port = Number(portInput.value || 22);

            if (!name) {
              modal.showError('请填写配置名称');
              nameInput.focus();
              return false;
            }
            if (!host) {
              modal.showError('请填写主机地址');
              hostInput.focus();
              return false;
            }
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              modal.showError('端口必须是 1-65535 之间的整数');
              portInput.focus();
              return false;
            }
            if (savePassword.checked && !passInput.value && !keyInput.value.trim()) {
              modal.showError('勾选“记住密码”时必须填写密码');
              passInput.focus();
              return false;
            }

            const payload: Partial<SshConfig> = {
              id: existing?.id,
              name,
              host,
              port,
              username: userInput.value.trim(),
              password: passInput.value,
              savePassword: savePassword.checked,
              privateKeyPath: keyInput.value.trim() || undefined,
              passphrase: passphraseInput.value || undefined,
              note: noteInput.value.trim() || undefined,
            };

            modal.setBusy(true);
            try {
              const saved = await api.saveConfig(payload);
              resolve(saved);
            } catch (err) {
              modal.setBusy(false);
              modal.showError(`保存失败：${err instanceof Error ? err.message : String(err)}`);
              return false;
            }
          },
        },
      ],
    });

    const form = el('div', {
      children: [
        textField('配置名称 *', nameInput, '用于在左侧列表中区分不同服务器'),
        el('div', {
          className: 'field-row',
          children: [
            el('div', {
              className: 'field',
              children: [el('label', { text: '主机地址 *' }), hostInput],
            }),
            el('div', {
              className: 'field narrow',
              children: [el('label', { text: '端口' }), portInput],
            }),
          ],
        }),
        textField('用户名', userInput, '留空则使用服务器默认用户'),
        textField(
          '密码',
          passInput,
          '密码使用 Windows DPAPI 加密后保存在本机，仅当前系统账户可解密',
          el('div', {
            className: 'input-with-btn',
            children: [
              passInput,
              el('label', {
                className: 'checkbox-row',
                title: '显示密码',
                children: [showPassword, el('span', { text: '显示' })],
              }),
            ],
          }),
        ),
        el('label', {
          className: 'checkbox-row',
          children: [savePassword, el('span', { text: '记住密码（下次自动填充）' })],
        }),
        el('div', { className: 'section-title', text: '密钥认证（可选）' }),
        textField(
          '私钥文件',
          keyInput,
          '支持 OpenSSH 格式（id_rsa / id_ed25519）。PuTTY 的 .ppk 需先转换',
          el('div', { className: 'input-with-btn', children: [keyInput, browseBtn] }),
        ),
        textField('私钥口令', passphraseInput),
        textField('备注', noteInput),
      ],
    });

    modal.body.appendChild(form);
    nameInput.focus();
    if (isEdit) nameInput.select();

    // 取消 / 遮罩关闭时返回 null
    const observer = new MutationObserver(() => {
      if (!modal.backdrop.isConnected) {
        observer.disconnect();
        resolve(null);
      }
    });
    observer.observe(document.getElementById('modal-root') as HTMLElement, { childList: true });
  });
}

/* ===================================================================== */
/* 设置对话框                                                             */
/* ===================================================================== */

export interface SettingsDialogResult {
  settings: AppSettings;
  /** 用户是否点击了“保存” */
  saved: boolean;
}

export function openSettingsDialog(current: AppSettings): Promise<SettingsDialogResult> {
  return new Promise((resolve) => {
    const draft: AppSettings = { ...current };
    let saved = false;

    const fontSelect = el('select');
    const fontOptions: Array<[string, string]> = [
      ['Cascadia Mono', "'Cascadia Mono', Consolas, monospace"],
      ['Cascadia Code', "'Cascadia Code', Consolas, monospace"],
      ['Consolas', "Consolas, 'Courier New', monospace"],
      ['JetBrains Mono', "'JetBrains Mono', Consolas, monospace"],
      ['Sarasa Mono SC（等宽中文）', "'Sarasa Mono SC', 'Microsoft YaHei Mono', monospace"],
      ['等线 / 雅黑', "'Microsoft YaHei', 'Microsoft YaHei UI', monospace"],
      ['Courier New', "'Courier New', monospace"],
    ];
    for (const [label, value] of fontOptions) {
      fontSelect.appendChild(el('option', { text: label, attrs: { value } }));
    }
    fontSelect.value = current.fontFamily;
    if (!fontSelect.value) fontSelect.selectedIndex = 0;

    const sizeInput = el('input', { attrs: { type: 'number', min: '8', max: '40', step: '1' } });
    sizeInput.value = String(current.fontSize);

    const lineHeightInput = el('input', { attrs: { type: 'number', min: '1', max: '2', step: '0.05' } });
    lineHeightInput.value = String(current.lineHeight);

    const themeSelect = el('select');
    for (const name of THEME_ORDER) {
      themeSelect.appendChild(el('option', { text: THEMES[name].label, attrs: { value: name } }));
    }
    themeSelect.value = current.theme;

    const scrollbackInput = el('input', { attrs: { type: 'number', min: '500', max: '200000', step: '1000' } });
    scrollbackInput.value = String(current.scrollback);

    const cursorSelect = el('select');
    for (const [label, value] of [
      ['竖线 |', 'bar'],
      ['方块 █', 'block'],
      ['下划线 _', 'underline'],
    ]) {
      cursorSelect.appendChild(el('option', { text: label, attrs: { value } }));
    }
    cursorSelect.value = current.cursorStyle;

    const blinkCheckbox = el('input', { attrs: { type: 'checkbox' } });
    blinkCheckbox.checked = current.cursorBlink;

    const transportSelect = el('select');
    for (const [label, value] of [
      ['内置 ssh2 库（默认）', 'ssh2'],
      ['系统 ssh.exe（受管控网络可尝试）', 'systemSsh'],
    ]) {
      transportSelect.appendChild(el('option', { text: label, attrs: { value } }));
    }
    transportSelect.value = current.transport;

    const hostListBox = el('div', { className: 'host-list' });
    const refreshHosts = async () => {
      const hosts = await api.listKnownHosts();
      hostListBox.textContent = '';
      if (!hosts.length) {
        hostListBox.appendChild(el('div', { className: 'empty-tip', text: '暂无已记录的主机指纹' }));
        return;
      }
      for (const item of hosts) {
        const removeBtn = el('button', { className: 'btn btn-danger btn-sm', text: '删除' });
        removeBtn.addEventListener('click', async () => {
          await api.forgetKnownHost(item.host, item.port);
          void refreshHosts();
        });
        hostListBox.appendChild(
          el('div', {
            className: 'host-row',
            children: [
              el('span', { className: 'host-name', text: `${item.host}:${item.port}` }),
              el('span', { className: 'host-fp', text: item.fingerprint, title: item.fingerprint }),
              removeBtn,
            ],
          }),
        );
      }
    };

    const modal = openModal({
      title: '设置',
      width: 'wide',
      buttons: [
        { label: '关闭' },
        {
          label: '保存',
          variant: 'primary',
          autofocus: true,
          onClick: async () => {
            draft.fontFamily = fontSelect.value;
            draft.fontSize = Number(sizeInput.value) || current.fontSize;
            draft.lineHeight = Number(lineHeightInput.value) || current.lineHeight;
            draft.theme = themeSelect.value;
            draft.scrollback = Number(scrollbackInput.value) || current.scrollback;
            draft.cursorStyle = cursorSelect.value as AppSettings['cursorStyle'];
            draft.cursorBlink = blinkCheckbox.checked;
            draft.transport = transportSelect.value as AppSettings['transport'];
            saved = true;
            resolve({ settings: draft, saved });
          },
        },
      ],
    });

    modal.body.appendChild(
      el('div', {
        children: [
          el('div', { className: 'section-title', text: '终端外观' }),
          textField('字体', fontSelect),
          el('div', {
            className: 'field-row',
            children: [
              el('div', { className: 'field', children: [el('label', { text: '字号 (px)' }), sizeInput] }),
              el('div', { className: 'field', children: [el('label', { text: '行高倍数' }), lineHeightInput] }),
              el('div', { className: 'field', children: [el('label', { text: '配色主题' }), themeSelect] }),
            ],
          }),
          el('div', {
            className: 'field-row',
            children: [
              el('div', { className: 'field', children: [el('label', { text: '光标样式' }), cursorSelect] }),
              el('div', {
                className: 'field',
                children: [
                  el('label', { text: '光标闪烁' }),
                  el('label', {
                    className: 'checkbox-row',
                    children: [blinkCheckbox, el('span', { text: '启用' })],
                  }),
                ],
              }),
            ],
          }),
          textField('回看缓冲行数', scrollbackInput, '修改后对新标签立即生效，已有标签也会同步调整'),
          el('div', { className: 'section-title', text: '连接' }),
          textField(
            'SSH 传输层',
            transportSelect,
            '公司安全软件若只放行系统 ssh 客户端，可切换为系统 ssh.exe（由 Windows 自带的 OpenSSH 发起连接，密码自动填充）。切换后对新连接生效；该模式下连接期间调整窗口尺寸暂不生效。',
          ),
          el('div', { className: 'section-title', text: '已信任的主机指纹' }),
          el('div', {
            className: 'hint',
            text: '首次连接会自动记录指纹；若指纹与记录不符将拒绝连接（防止中间人攻击）。服务器重装后可在此删除记录。',
          }),
          hostListBox,
        ],
      }),
    );

    void refreshHosts();

    const observer = new MutationObserver(() => {
      if (!modal.backdrop.isConnected) {
        observer.disconnect();
        resolve({ settings: draft, saved });
      }
    });
    observer.observe(document.getElementById('modal-root') as HTMLElement, { childList: true });
  });
}

/* ===================================================================== */
/* 快捷键说明                                                             */
/* ===================================================================== */

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl + N', '新建服务器配置'],
  ['Ctrl + R', '重新连接当前标签'],
  ['Ctrl + W', '关闭当前标签（同时断开 SSH 连接）'],
  ['Ctrl + Shift + C', '复制终端中选中的内容'],
  ['Ctrl + Shift + V', '粘贴到终端（Ctrl+V 会把 0x16 原样发给远端）'],
  ['Shift + Insert', '粘贴到终端（Windows 传统习惯）'],
  ['Ctrl + Shift + A', '全选终端内容'],
  ['Ctrl + Shift + F', '在终端中查找（Enter 下一个 / Shift+Enter 上一个）'],
  ['Ctrl + C', '发送中断信号（SIGINT）给远端程序'],
  ['Ctrl + D', '发送 EOF，可用于退出 shell'],
  ['Tab', '远端命令补全'],
  ['Alt + 滚轮', '快速滚动'],
  ['Ctrl + K', '清空终端视口与回看缓冲'],
  ['Ctrl + + / - / 0', '放大 / 缩小 / 重置终端字号'],
  ['鼠标右键', '打开终端操作菜单（复制、粘贴、重连、断开等）'],
  ['双击左侧配置', '打开新标签并连接'],
];

export function openShortcutsDialog(): void {
  const modal = openModal({
    title: '快捷键说明',
    width: 'wide',
    buttons: [{ label: '知道了', variant: 'primary', autofocus: true }],
  });

  const table = el('table', { className: 'shortcut-table' });
  for (const [key, desc] of SHORTCUTS) {
    const row = el('tr');
    row.appendChild(el('td', { text: key }));
    row.appendChild(el('td', { text: desc }));
    table.appendChild(row);
  }
  modal.body.appendChild(table);
}

/* ===================================================================== */
/* 配置详情                                                               */
/* ===================================================================== */

export function openConfigInfoDialog(config: SshConfig): void {
  const rows: Array<[string, string]> = [
    ['名称', config.name],
    ['主机', config.host],
    ['端口', String(config.port)],
    ['用户名', config.username || '（未设置）'],
    ['认证方式', config.privateKeyPath ? `私钥：${config.privateKeyPath}` : config.password ? '密码' : '未设置'],
    ['记住密码', config.savePassword ? `是${config.password ? '（已保存）' : '（尚未保存）'}` : '否'],
    ['备注', config.note || '—'],
    ['创建时间', formatTime(config.createdAt)],
    ['最近连接', formatTime(config.lastUsedAt)],
  ];

  const modal = openModal({
    title: '配置详情',
    buttons: [{ label: '关闭', autofocus: true }],
  });

  const table = el('table', { className: 'shortcut-table' });
  for (const [key, value] of rows) {
    const row = el('tr');
    row.appendChild(el('td', { text: key }));
    row.appendChild(el('td', { text: value }));
    table.appendChild(row);
  }
  modal.body.appendChild(table);
}
