import { el } from './util';

type ToastKind = 'info' | 'ok' | 'warn' | 'err';

const root = () => document.getElementById('toast-root') as HTMLElement;

/** 右下角轻提示，自动消失；用于「已复制」「配置已保存」这类即时反馈 */
export function toast(message: string, kind: ToastKind = 'info', duration = 2200): void {
  const host = root();
  if (!host) return;

  const node = el('div', { className: `toast ${kind}`, text: message });
  host.appendChild(node);

  window.setTimeout(() => {
    node.classList.add('out');
    window.setTimeout(() => node.remove(), 200);
  }, duration);
}

/** 常驻错误提示（不自动消失，点击关闭） */
export function stickyToast(message: string, kind: ToastKind = 'err'): void {
  const host = root();
  if (!host) return;
  const node = el('div', { className: `toast ${kind}`, text: message, title: '点击关闭' });
  node.style.pointerEvents = 'auto';
  node.style.cursor = 'pointer';
  node.addEventListener('click', () => node.remove());
  host.appendChild(node);
}
