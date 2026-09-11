import { el } from './util';

export interface ModalButton {
  label: string;
  variant?: 'primary' | 'default' | 'danger';
  /** 返回 false 可阻止关闭 */
  onClick?: (modal: ModalHandle) => void | boolean | Promise<void | boolean>;
  /** 是否在打开时聚焦 */
  autofocus?: boolean;
}

export interface ModalHandle {
  /** 弹窗根节点 */
  backdrop: HTMLElement;
  /** 内容容器，业务方往里塞表单 */
  body: HTMLElement;
  /** 底部按钮容器 */
  footer: HTMLElement;
  /** 显示错误提示条 */
  showError(message: string): void;
  clearError(): void;
  close(): void;
  setBusy(busy: boolean): void;
}

const modalRoot = () => document.getElementById('modal-root') as HTMLElement;

/**
 * 通用模态框。
 * 支持 Esc 关闭、点击遮罩关闭、回车触发主按钮。
 */
export function openModal(options: {
  title: string;
  width?: 'normal' | 'wide';
  buttons: ModalButton[];
  /** 是否允许点遮罩/Esc 关闭 */
  dismissable?: boolean;
}): ModalHandle {
  const dismissable = options.dismissable !== false;

  const errorBox = el('div', { className: 'modal-error' });
  const body = el('div', { className: 'modal-body', children: [errorBox] });
  const footer = el('div', { className: 'modal-foot' });
  const closeBtn = el('button', { className: 'modal-close', text: '✕', title: '关闭' });

  const head = el('div', {
    className: 'modal-head',
    children: [el('span', { text: options.title }), closeBtn],
  });

  const modal = el('div', {
    className: `modal${options.width === 'wide' ? ' wide' : ''}`,
    children: [head, body, footer],
  });
  const backdrop = el('div', { className: 'modal-backdrop', children: [modal] });

  let closed = false;

  const handle: ModalHandle = {
    backdrop,
    body,
    footer,
    showError(message: string) {
      errorBox.textContent = message;
      errorBox.classList.add('show');
    },
    clearError() {
      errorBox.textContent = '';
      errorBox.classList.remove('show');
    },
    close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      backdrop.remove();
    },
    setBusy(busy: boolean) {
      for (const btn of footer.querySelectorAll<HTMLButtonElement>('button')) {
        btn.disabled = busy;
      }
    },
  };

  const buttonList: HTMLButtonElement[] = [];
  for (const spec of options.buttons) {
    const btn = el('button', {
      className: `btn${spec.variant === 'primary' ? ' btn-primary' : spec.variant === 'danger' ? ' btn-danger' : ''}`,
      text: spec.label,
    });
    btn.addEventListener('click', async () => {
      handle.clearError();
      const result = await spec.onClick?.(handle);
      if (result === false) return;
      handle.close();
    });
    buttonList.push(btn);
    footer.appendChild(btn);
  }

  closeBtn.addEventListener('click', () => {
    if (dismissable) handle.close();
  });

  backdrop.addEventListener('mousedown', (event) => {
    if (dismissable && event.target === backdrop) handle.close();
  });

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && dismissable) {
      event.preventDefault();
      event.stopPropagation();
      handle.close();
      return;
    }
    // 在单行输入框内回车 = 点击主按钮
    if (event.key === 'Enter' && !event.shiftKey) {
      const target = event.target as HTMLElement | null;
      const isTextarea = target?.tagName === 'TEXTAREA';
      const primary = buttonList.find((b) => b.classList.contains('btn-primary'));
      if (primary && !isTextarea && !target?.classList.contains('modal-close')) {
        event.preventDefault();
        primary.click();
      }
    }
  }

  document.addEventListener('keydown', onKeyDown, true);
  modalRoot().appendChild(backdrop);

  const auto = options.buttons.findIndex((b) => b.autofocus);
  const focusTarget = auto >= 0 ? buttonList[auto] : null;
  if (focusTarget) focusTarget.focus();

  return handle;
}

/** 危险操作确认框 */
export function confirmDialog(options: {
  title: string;
  message: string;
  detail?: string;
  confirmText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const detailNode = options.detail
      ? el('div', { className: 'hint', text: options.detail })
      : null;
    const handle = openModal({
      title: options.title,
      buttons: [
        {
          label: '取消',
          onClick: () => {
            decided = true;
            resolve(false);
          },
        },
        {
          label: options.confirmText ?? '确定',
          variant: options.danger ? 'danger' : 'primary',
          autofocus: true,
          onClick: () => {
            decided = true;
            resolve(true);
          },
        },
      ],
    });
    handle.body.appendChild(el('div', { text: options.message }));
    if (detailNode) handle.body.appendChild(detailNode);
    // 遮罩关闭时视为取消
    const observer = new MutationObserver(() => {
      if (!handle.backdrop.isConnected && !decided) {
        decided = true;
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(modalRoot(), { childList: true });
  });
}

export { el };
