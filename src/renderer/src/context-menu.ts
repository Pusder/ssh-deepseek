import { copyText, el, on } from './util';

export interface ContextMenuItem {
  /** 分隔线 */
  separator?: boolean;
  label?: string;
  /** 右侧快捷键提示 */
  key?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

let activeMenu: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeContextMenu(): void {
  cleanup?.();
  cleanup = null;
  activeMenu?.remove();
  activeMenu = null;
}

/** 自定义右键菜单，替代浏览器默认菜单（Terminal 内需要复制/粘贴等终端专属操作） */
export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeContextMenu();

  const menu = el('div', { className: 'ctx-menu' });
  for (const item of items) {
    if (item.separator) {
      menu.appendChild(el('div', { className: 'ctx-sep' }));
      continue;
    }
    const row = el('div', {
      className: `ctx-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`,
      children: [
        el('span', { text: item.label ?? '' }),
        item.key ? el('span', { className: 'ctx-key', text: item.key }) : null,
      ],
    });
    row.addEventListener('click', () => {
      if (item.disabled) return;
      closeContextMenu();
      item.onClick?.();
    });
    menu.appendChild(row);
  }

  document.getElementById('context-menu-root')?.appendChild(menu);
  activeMenu = menu;

  // 贴边时自动翻转，保证菜单完整可见
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = x + rect.width > vw - 4 ? Math.max(4, x - rect.width) : x;
  const top = y + rect.height > vh - 4 ? Math.max(4, y - rect.height) : y;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const off = [
    on(document, 'mousedown', (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) closeContextMenu();
    }),
    on(document, 'wheel', () => closeContextMenu(), { passive: true }),
    on(window, 'blur', () => closeContextMenu()),
    on(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    }),
  ];
  cleanup = () => off.forEach((fn) => fn());
}

/** 监听终端区域的右键：在捕获阶段拦截，避免 xterm 自行处理 */
export function bindContextMenu(
  target: HTMLElement,
  builder: (event: MouseEvent) => ContextMenuItem[] | null,
): () => void {
  return on(
    target,
    'contextmenu',
    (event: MouseEvent) => {
      const items = builder(event);
      if (!items || !items.length) return;
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, items);
    },
    { capture: true },
  );
}

/** 复制文本并给出提示（供菜单复用） */
export async function copyWithToast(text: string, toast: (msg: string, kind?: 'ok' | 'warn' | 'err') => void): Promise<void> {
  const ok = await copyText(text);
  toast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'ok' : 'err');
}
