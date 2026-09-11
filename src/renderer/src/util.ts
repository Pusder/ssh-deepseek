/** 通用 DOM / 格式化工具 */

type ElOptions = {
  className?: string;
  text?: string;
  html?: string;
  title?: string;
  attrs?: Record<string, string>;
  children?: (Node | null | undefined)[];
};

/** 极简元素创建器，避免在业务代码里堆砌 innerHTML */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;
  if (options.title) node.title = options.title;
  if (options.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) node.setAttribute(k, v);
  }
  if (options.children) {
    for (const child of options.children) if (child) node.appendChild(child);
  }
  return node;
}

/** 在指定父节点内按选择器查找，找不到直接抛错（早失败优于静默 null） */
export function need<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`缺少必需的 DOM 节点: ${selector}`);
  return found;
}

/** 绑定事件并返回解绑函数 */
export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K | string,
  handler: (event: any) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 复制到剪贴板（渲染进程无权限时回退到主进程） */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      window.dshSsh.writeClipboardText(text);
      return true;
    } catch {
      return false;
    }
  }
}

/** 读取剪贴板文本（渲染进程无权限时回退到主进程） */
export async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    try {
      return window.dshSsh.readClipboardText();
    } catch {
      return '';
    }
  }
}

/** 秒数 -> mm:ss / hh:mm:ss */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 时间戳 -> 本地时间字符串 */
export function formatTime(ts?: number): string {
  if (!ts) return '从未连接';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 生成递增的 DOM id */
let uidCounter = 0;
export function uid(prefix = 'id'): string {
  return `${prefix}-${++uidCounter}`;
}
