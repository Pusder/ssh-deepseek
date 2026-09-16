/**
 * 右侧工具面板：项目导航 + 编译命令 + 单编命令。
 *
 * - 项目导航：填一个远端根目录（支持 ~ 前缀），点「刷新」探测两级子目录
 *   （如 ~/MTK → P6711EVF → a13/a16），点击条目复制 cd 命令；不自动刷新。
 * - 编译命令：根据远端当前目录自动生成
 *   `./buildall_user.sh <项目名> -vf ../<vendor目录> modem pac` 并复制到剪贴板。
 *   左键 = 直接生成；右键 = 直接生成 / 自定义生成（可编辑项目名与 vendor 目录）。
 * - 单编命令：在项目一级子目录（如 …/P6711EVF/a16，以项目导航的条目路径为准）下使用。
 *   快捷命令只「输入到终端不回车」，由用户检查后自己执行；
 *   list_products 结果按项目目录记忆，lunch 的 product 从记忆里下拉选择。
 *
 * 所有远端信息都通过 TerminalTab.runProbe 在当前会话里执行命令获得，不新开连接。
 */
import type { TerminalTab } from './terminal';
import { api } from './api';
import { openModal } from './dialogs';
import { bindContextMenu, showContextMenu, type ContextMenuItem } from './context-menu';
import { toast } from './toast';
import { copyText, el } from './util';

/** 编译命令模板的固定尾部（需求约定仅项目名 / vendor 目录可编辑） */
const BUILD_TAIL_ARGS = 'modem pac';

/** buildall_user.sh 参数说明（随包内置，图标展开/收起） */
const BUILD_USAGE = `USAGE mediatek: ./buildall_user.sh <PROJECT> [ota] [pac] [copy] [boot] [bootloader] [recovery] [snod] [api] [env] [nodex] [nomodem] [-m <MODULE>] [-vf <PATH>]
* OTA : 编译OTA包
* BOOT : 编译boot.img
* DTBO : 编译dtbo.img
* CHIPRAM : 编译chipram
* RECOVERY : 编译recovery.img
* BOOTLOADER : 编译bootloader(u-boot.bin)
* SNOD : 打包system.img
* -m <MODULE> : 编译<MODULE>指定的模块(-m bootloader)
* -vf <PATH> : 指定VF编译模式Vendor代码路径
* MODEM : 编译modem(不编译模块时自动编译)
* NOMODEM : 不编译modem
* PAC : 编译完成后自动打包(*.pac)
* COPY : 拷贝覆盖文件，不启动编译
* API : 提示需要更新api时加该参数:更新api.txt，编译完成后请将framework中的api文件提交到git上
* ENV : 单编source时加该参数，只设置环境，不启动编译
* NODEX : 全编DEBUG版本时不生成odex文件
* 参数不区分大小写和顺序`;

export interface ToolsPanelCallbacks {
  /** 当前激活的终端标签（可能为 null） */
  getActiveTab(): TerminalTab | null;
  /** 用户点击面板的收起按钮 */
  onHide(): void;
}

interface NavEntry {
  group: string;
  name: string;
  path: string;
}

/** 取路径最后一段（目录名）；容忍结尾的 / */
function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p;
}

/** 取父目录；根目录/非法路径返回 null */
function dirname(p: string): string | null {
  const idx = p.replace(/\/+$/, '').lastIndexOf('/');
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

export class ToolsPanel {
  readonly root: HTMLElement;

  private callbacks: ToolsPanelCallbacks;
  private rootInput: HTMLInputElement;
  private navList: HTMLElement;
  private navEntries: NavEntry[] = [];
  private buildBtn: HTMLButtonElement;
  private busy = false;

  /* 单编相关控件 */
  private productSelect: HTMLSelectElement;
  private variantInput: HTMLInputElement;
  private moduleInput: HTMLInputElement;
  private driveInput: HTMLInputElement;
  /** 会话内缓存的远端 cwd（60 秒内复用，减少终端里的探测命令） */
  private lastCwd: string | null = null;
  private lastCwdAt = 0;

  constructor(callbacks: ToolsPanelCallbacks) {
    this.callbacks = callbacks;

    /* ------------------------- 项目导航 ------------------------- */
    this.rootInput = el('input', {
      className: 'tool-root-input',
      attrs: { type: 'text', placeholder: '远端根目录，如 ~/MTK', spellcheck: 'false' },
      title: '远端根目录路径，支持 ~ 前缀（按主机记忆）',
    });
    const refreshBtn = el('button', { className: 'btn btn-sm', text: '刷新' });
    refreshBtn.addEventListener('click', () => void this.refreshNav());

    this.navList = el('div', { className: 'tool-list' });

    const navWidget = el('section', {
      className: 'tool-widget',
      children: [
        el('div', { className: 'tool-title', text: '项目导航' }),
        el('div', { className: 'tool-row', children: [this.rootInput, refreshBtn] }),
        el('div', { className: 'tool-hint', text: '点击条目复制 cd 命令；右键可发送到终端。刷新才会重新探测目录。' }),
        this.navList,
      ],
    });

    /* ------------------------- 编译命令 ------------------------- */
    this.buildBtn = el('button', { className: 'btn btn-primary tool-main-btn', text: '生成编译命令并复制' });
    this.buildBtn.addEventListener('click', () => void this.generateBuild());

    // 参数说明：纯图标切换展开/收起（▸ 收起 / ▾ 展开）
    const usageToggle = el('button', {
      className: 'btn btn-ghost btn-sm tool-usage-toggle',
      text: '▸',
      title: '展开 / 收起 buildall_user.sh 参数说明',
    });
    const usageBlock = el('pre', { className: 'tool-usage hidden', text: BUILD_USAGE });
    usageToggle.addEventListener('click', () => {
      const open = usageBlock.classList.toggle('hidden') === false;
      usageToggle.textContent = open ? '▾' : '▸';
    });

    const buildWidget = el('section', {
      className: 'tool-widget',
      children: [
        el('div', {
          className: 'tool-title tool-title-row',
          children: [el('span', { text: '编译命令' }), usageToggle],
        }),
        this.buildBtn,
        el('div', {
          className: 'tool-hint',
          text: '在项目源码目录（如 …/P6711EVF/a16）下点击，自动生成 buildall_user.sh 命令。左键直接生成复制；右键可自定义生成。',
        }),
        usageBlock,
      ],
    });

    /* ------------------------- 单编命令 ------------------------- */
    const collectBtn = el('button', {
      className: 'btn btn-sm tool-main-btn',
      text: '采集 product 列表',
      title: '依次执行 source build/envsetup.sh 和 list_products（分成两条命令，首次需要几秒）',
    });
    collectBtn.addEventListener('click', () => void this.collectProducts());

    this.productSelect = el('select', { title: 'product（来自 list_products，按项目目录记忆）' });
    this.variantInput = el('input', {
      attrs: { type: 'text', spellcheck: 'false' },
      title: 'lunch 后两段，默认 next-userdebug，可修改',
    });
    this.variantInput.value = 'next-userdebug';

    const quickBtn = (text: string, cmd: string, title?: string): HTMLButtonElement => {
      const b = el('button', { className: 'btn btn-sm', text, title: title ?? `${cmd}（只输入不回车）` });
      b.addEventListener('click', () => this.typeQuickCmd(cmd));
      return b;
    };
    const lunchBtn = el('button', {
      className: 'btn btn-sm',
      text: 'lunch …',
      title: 'lunch <product>-<后缀>，只输入不回车',
    });
    lunchBtn.addEventListener('click', () => void this.typeLunch());

    this.moduleInput = el('input', {
      attrs: { type: 'text', spellcheck: 'false', placeholder: '模块目录，如 …/a16/<模块路径>' },
      title: '模块目录（按项目记忆）',
    });
    const cdModuleBtn = el('button', { className: 'btn btn-sm', text: 'cd 模块目录', title: 'cd <模块目录>，只输入不回车' });
    cdModuleBtn.addEventListener('click', () => void this.typeCdModule());

    this.driveInput = el('input', {
      className: 'tool-drive',
      attrs: { type: 'text', spellcheck: 'false', title: '本地映射盘符（远端主目录对应的盘）' },
    });
    this.driveInput.value = localStorage.getItem('dsh.explorerDrive') ?? 'Z';
    const openOutBtn = el('button', {
      className: 'btn btn-sm',
      text: '打开编译输出目录',
      title: '在资源管理器中打开 <项目目录>\\out\\target\\product',
    });
    openOutBtn.addEventListener('click', () => void this.openOutDir());

    const singleWidget = el('section', {
      className: 'tool-widget',
      children: [
        el('div', { className: 'tool-title', text: '单编命令' }),
        collectBtn,
        el('div', { className: 'tool-inline', children: [this.productSelect, this.variantInput] }),
        el('div', { className: 'tool-grid', children: [
          quickBtn('source', 'source build/envsetup.sh'),
          quickBtn('list_products', 'list_products'),
          lunchBtn,
          quickBtn('mm', 'mm'),
        ] }),
        el('div', { className: 'tool-inline', children: [this.moduleInput, cdModuleBtn] }),
        el('div', { className: 'tool-inline', children: [this.driveInput, openOutBtn] }),
        el('div', {
          className: 'tool-hint',
          text: '在项目一级子目录（如 …/P6711EVF/a16，须已出现在项目导航里）下使用。快捷命令只输入到终端不回车，检查后自己执行。',
        }),
      ],
    });

    /* --------------------------- 面板骨架 --------------------------- */
    const hideBtn = el('button', { className: 'btn btn-ghost btn-sm', text: '✕', title: '收起工具面板' });
    hideBtn.addEventListener('click', () => this.callbacks.onHide());

    this.root = el('aside', {
      attrs: { id: 'tools-panel' },
      children: [
        el('div', {
          className: 'tools-head',
          children: [el('span', { text: '工具' }), hideBtn],
        }),
        el('div', { className: 'tools-body', children: [navWidget, buildWidget, singleWidget] }),
      ],
    });

    bindContextMenu(this.root, (event) => this.buildPanelMenu(event));
  }

  /** 面板右键：编译区给生成菜单，其余给展开项目导航的便捷项 */
  private buildPanelMenu(event: MouseEvent): ContextMenuItem[] | null {
    const target = event.target as HTMLElement;
    const buildWidget = target.closest('.tool-widget:nth-of-type(2)');
    if (buildWidget) {
      return [
        { label: '直接生成并复制', onClick: () => void this.generateBuild() },
        { label: '自定义生成…', onClick: () => void this.openBuildDialog() },
        { separator: true },
        { label: '清除当前目录的 vendor 记忆', onClick: () => void this.clearBuildMemory() },
      ];
    }
    return [
      { label: '刷新项目导航', onClick: () => void this.refreshNav() },
      { label: '自定义生成编译命令…', onClick: () => void this.openBuildDialog() },
    ];
  }

  /* ================================================================== */
  /* 公共接口                                                            */
  /* ================================================================== */

  /** 切换主机时恢复对应主机记忆的根目录 */
  applyHost(host: string): void {
    const saved = host ? localStorage.getItem(`dsh.navRoot.${host}`) : null;
    this.rootInput.value = saved ?? '';
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
    // body 级开关：让终端栈给面板让出空间（见 layout.css 的 body.tools-open 规则）
    document.body.classList.toggle('tools-open', visible);
  }

  /* ================================================================== */
  /* 项目导航                                                            */
  /* ================================================================== */

  private connectedTab(): TerminalTab | null {
    const tab = this.callbacks.getActiveTab();
    if (!tab) {
      toast('没有活动标签页', 'err');
      return null;
    }
    if (tab.currentStatus !== 'connected') {
      toast('当前会话未连接，无法探测远端目录', 'err');
      return null;
    }
    return tab;
  }

  /** 手动刷新：探测根目录下的一级子目录及其子目录（两级），条目路径为 ~ 展开后的绝对路径 */
  async refreshNav(): Promise<void> {
    const rootPath = this.rootInput.value.trim();
    if (!rootPath) {
      toast('请先填写远端根目录路径', 'err');
      return;
    }
    const tab = this.connectedTab();
    if (!tab || this.busy) return;
    this.busy = true;
    this.navList.replaceChildren(el('div', { className: 'tool-hint', text: '探测中…' }));
    try {
      // probeSubdirs 返回 ~ 展开后的完整路径（如 /home/dsp/MTK/P6711EVF）
      const level1 = await tab.probeSubdirs(rootPath);
      if (!level1.length) {
        throw new Error(`根目录 ${rootPath} 下没有子目录（路径不存在或为空）`);
      }
      const entries: NavEntry[] = [];
      for (const level1Path of level1) {
        let children: string[] = [];
        try {
          children = await tab.probeSubdirs(level1Path);
        } catch {
          children = []; // 单个一级目录探测失败不阻塞整体
        }
        if (children.length) {
          for (const childPath of children) {
            entries.push({ group: basename(level1Path), name: basename(childPath), path: childPath });
          }
        } else {
          // 一级目录本身没有子目录：直接作为条目展示
          entries.push({ group: basename(level1Path), name: '', path: level1Path });
        }
      }
      this.navEntries = entries;
      localStorage.setItem(`dsh.navRoot.${tab.config.host}`, rootPath);
      this.renderNav();
      toast(`已更新项目导航（${entries.length} 项）`, 'ok');
    } catch (err) {
      this.navList.replaceChildren(
        el('div', { className: 'tool-hint', text: err instanceof Error ? err.message : String(err) }),
      );
      toast(err instanceof Error ? err.message : String(err), 'err', 3600);
    } finally {
      this.busy = false;
    }
  }

  private renderNav(): void {
    const rows: Node[] = [];
    let lastGroup = '';
    for (const entry of this.navEntries) {
      if (entry.group !== lastGroup) {
        lastGroup = entry.group;
        rows.push(el('div', { className: 'tool-group', text: entry.group }));
      }
      const row = el('button', {
        className: 'tool-entry',
        text: entry.name || entry.group,
        title: entry.path,
      });
      row.addEventListener('click', () => void this.copyCd(entry.path));
      bindContextMenu(row, () => [
        { label: `复制 cd 命令`, onClick: () => void this.copyCd(entry.path) },
        { label: '发送到终端执行', onClick: () => this.sendCd(entry.path) },
        { separator: true },
        { label: '复制路径', onClick: () => void copyText(entry.path) },
      ]);
      rows.push(row);
    }
    this.navList.replaceChildren(...rows);
  }

  private async copyCd(path: string): Promise<void> {
    const cmd = `cd ${path}`;
    const ok = await copyText(cmd);
    toast(ok ? `已复制：${cmd}` : '复制失败', ok ? 'ok' : 'err', 2600);
  }

  private sendCd(path: string): void {
    const tab = this.callbacks.getActiveTab();
    if (!tab || tab.currentStatus !== 'connected') {
      toast('当前会话未连接', 'err');
      return;
    }
    tab.sendLine(`cd ${path}`);
    toast('已发送 cd 命令', 'ok');
  }

  /* ================================================================== */
  /* 编译命令                                                            */
  /* ================================================================== */

  /** 清除当前目录的 vendor 记忆（需要先探测 cwd） */
  private async clearBuildMemory(): Promise<void> {
    const tab = this.connectedTab();
    if (!tab) return;
    try {
      const cwd = await tab.probeCwd();
      const key = `dsh.buildVendor.${cwd}`;
      if (localStorage.getItem(key) === null) {
        toast('该目录没有 vendor 记忆', 'info');
        return;
      }
      localStorage.removeItem(key);
      toast('已清除该目录的 vendor 记忆', 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err', 3600);
    }
  }

  /** 编译命令 = 模板 + 项目名 + vendor 目录 */
  private buildCommand(project: string, vendor: string): string {
    return `./buildall_user.sh ${project} -vf ../${vendor} ${BUILD_TAIL_ARGS}`;
  }

  /**
   * 左键直接生成：cwd → 项目名（父目录名）→ vendor（记忆值；无记忆且父目录下
   * 只有一个其他子目录时自动采用；否则提示走「自定义生成」）。
   */
  private async generateBuild(): Promise<void> {
    const tab = this.connectedTab();
    if (!tab || this.busy) return;
    this.busy = true;
    this.buildBtn.disabled = true;
    try {
      const cwd = await tab.probeCwd();
      const parent = dirname(cwd);
      if (!parent) throw new Error('无法识别项目结构：当前目录缺少父目录');
      const project = basename(parent);
      const cwdBase = basename(cwd);

      const memoryKey = `dsh.buildVendor.${cwd}`;
      let vendor = localStorage.getItem(memoryKey);
      if (!vendor) {
        // probeSubdirs 返回完整路径，比较时同样用完整路径排除自身，名称取最后一段
        const siblings = (await tab.probeSubdirs(parent)).filter((d) => d !== cwd).map((d) => basename(d));
        if (siblings.length === 1) {
          vendor = siblings[0];
        } else if (!siblings.length) {
          throw new Error(`目录结构不符：${parent} 下没有其他子目录可作为 vendor 目录`);
        } else {
          throw new Error(
            `父目录下有 ${siblings.length} 个可用子目录（${siblings.join('、')}），请右键 →「自定义生成」选择 vendor 目录`,
          );
        }
      }

      const cmd = this.buildCommand(project, vendor);
      const ok = await copyText(cmd);
      toast(ok ? `已复制：${cmd}` : '复制失败', ok ? 'ok' : 'err', 4200);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err', 4200);
    } finally {
      this.busy = false;
      this.buildBtn.disabled = false;
    }
  }

  /** 右键「自定义生成」：自动按实际目录填充项目名与 vendor 目录，可手改 */
  private async openBuildDialog(): Promise<void> {
    const tab = this.connectedTab();
    if (!tab || this.busy) return;
    this.busy = true;
    this.buildBtn.disabled = true;
    try {
      const cwd = await tab.probeCwd();
      const parent = dirname(cwd);
      if (!parent) throw new Error('无法识别项目结构：当前目录缺少父目录');
      const project = basename(parent);
      const cwdBase = basename(cwd);

      let siblings: string[] = [];
      try {
        siblings = (await tab.probeSubdirs(parent)).filter((d) => d !== cwd).map((d) => basename(d));
      } catch {
        siblings = []; // 探测失败不阻塞手输
      }

      const memoryKey = `dsh.buildVendor.${cwd}`;
      const remembered = localStorage.getItem(memoryKey);

      const projectInput = el('input', {
        className: 'input',
        attrs: { type: 'text', spellcheck: 'false' },
      });
      projectInput.value = project;

      const vendorInput = el('input', {
        className: 'input',
        attrs: { type: 'text', spellcheck: 'false', list: 'dsh-vendor-options' },
      });
      vendorInput.value = remembered ?? siblings[0] ?? '';
      const datalist = el('datalist', { attrs: { id: 'dsh-vendor-options' } });
      for (const name of siblings) {
        datalist.appendChild(el('option', { attrs: { value: name } }));
      }

      const preview = el('div', { className: 'tool-preview' });
      const updatePreview = () => {
        preview.textContent = this.buildCommand(projectInput.value.trim() || '<项目名>', vendorInput.value.trim() || '<vendor>');
      };
      projectInput.addEventListener('input', updatePreview);
      vendorInput.addEventListener('input', updatePreview);
      updatePreview();

      const modal = openModal({
        title: '自定义生成编译命令',
        width: 'wide',
        buttons: [
          { label: '取消' },
          {
            label: '生成并复制',
            variant: 'primary',
            autofocus: true,
            onClick: async () => {
              const proj = projectInput.value.trim();
              const vendor = vendorInput.value.trim().replace(/\/+$/, '').split('/').pop() ?? '';
              if (!proj) {
                modal.showError('项目名不能为空');
                return false;
              }
              if (!vendor) {
                modal.showError('vendor 目录不能为空');
                return false;
              }
              const cmd = this.buildCommand(proj, vendor);
              const ok = await copyText(cmd);
              localStorage.setItem(memoryKey, vendor);
              toast(ok ? `已复制：${cmd}` : '复制失败', ok ? 'ok' : 'err', 4200);
              return true;
            },
          },
        ],
      });

      const fieldRow = (label: string, input: HTMLElement, hint?: string): HTMLElement =>
        el('div', {
          className: 'field',
          children: [
            el('label', { text: label }),
            input,
            hint ? el('span', { className: 'hint', text: hint }) : null,
          ],
        });

      modal.body.append(
        fieldRow('当前目录', el('div', { className: 'tool-preview', text: cwd })),
        fieldRow('项目名（父目录名，可编辑）', projectInput),
        fieldRow(
          'vendor 目录（可下拉选择或手输）',
          el('div', { children: [vendorInput, datalist] }),
          siblings.length ? `父目录 ${parent} 下的其他子目录：${siblings.join('、')}` : '未探测到父目录下的其他子目录，可手动输入目录名',
        ),
        fieldRow('生成命令（预览）', preview),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err', 4200);
    } finally {
      this.busy = false;
      this.buildBtn.disabled = false;
    }
  }

  /* ================================================================== */
  /* 单编命令                                                            */
  /* ================================================================== */

  /** 会话内缓存的远端 cwd（60 秒内复用，减少终端里的探测命令） */
  private async resolveCwd(tab: TerminalTab): Promise<string> {
    if (this.lastCwd && Date.now() - this.lastCwdAt < 60_000) return this.lastCwd;
    const cwd = await tab.probeCwd();
    this.lastCwd = cwd;
    this.lastCwdAt = Date.now();
    return cwd;
  }

  /** 单编工具只能在项目导航记录的项目目录（如 …/P6711EVF/a16）下使用 */
  private ensureProjectDir(cwd: string): boolean {
    if (!this.navEntries.length) {
      toast('请先在「项目导航」填写根目录并刷新——单编工具依据导航路径判断项目目录', 'err', 4000);
      return false;
    }
    if (!this.navEntries.some((e) => e.path === cwd)) {
      toast('当前目录不在项目导航条目中（如 …/P6711EVF/a16），请先 cd 到项目目录再使用', 'err', 4000);
      return false;
    }
    return true;
  }

  /** 把命令输入到终端但不回车，用户检查后自己执行 */
  private typeQuickCmd(cmd: string): void {
    const tab = this.connectedTab();
    if (!tab) return;
    tab.typeText(cmd);
    toast(`已输入（未回车）：${cmd}`, 'info', 2000);
  }

  private async withBusy(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err', 4200);
    } finally {
      this.busy = false;
    }
  }

  private productsFor(cwd: string): string[] {
    try {
      const raw = localStorage.getItem(`dsh.products.${cwd}`);
      const list = raw ? (JSON.parse(raw) as string[]) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** 按项目目录恢复 product 下拉与 variant / 模块目录记忆 */
  private fillProductSelect(cwd: string): void {
    this.productSelect.replaceChildren();
    for (const p of this.productsFor(cwd)) {
      this.productSelect.appendChild(el('option', { text: p, attrs: { value: p } }));
    }
    const variant = localStorage.getItem(`dsh.variant.${cwd}`);
    if (variant) this.variantInput.value = variant;
    const moduleDir = localStorage.getItem(`dsh.moduleDir.${cwd}`);
    if (moduleDir !== null) this.moduleInput.value = moduleDir;
  }

  /**
   * 采集 product 列表：source 与 list_products 分成两条命令执行
   * （第一条把 envsetup source 进当前 shell，第二条用标记捕获 list_products 输出）。
   * 结果按项目目录记忆，供 lunch 下拉选择。
   */
  private async collectProducts(): Promise<void> {
    await this.withBusy(async () => {
      const tab = this.connectedTab();
      if (!tab) return;
      const cwd = await this.resolveCwd(tab);
      if (!this.ensureProjectDir(cwd)) return;
      // 第一条：source build/envsetup.sh（envsetup 可能要几秒，超时给足）
      await tab.runProbe('source build/envsetup.sh', 60000);
      // 第二条：list_products
      const out = await tab.runProbe('list_products', 30000);
      const products = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.includes(' '));
      if (!products.length) {
        throw new Error('list_products 没有输出，请确认 envsetup 已生效且当前为项目目录');
      }
      localStorage.setItem(`dsh.products.${cwd}`, JSON.stringify(products));
      localStorage.setItem(`dsh.variant.${cwd}`, this.variantInput.value.trim() || 'next-userdebug');
      this.fillProductSelect(cwd);
      toast(`已记住 ${products.length} 个 product（lunch 下拉已更新）`, 'ok');
    });
  }

  private async typeLunch(): Promise<void> {
    await this.withBusy(async () => {
      const tab = this.connectedTab();
      if (!tab) return;
      const cwd = await this.resolveCwd(tab);
      if (!this.ensureProjectDir(cwd)) return;
      this.fillProductSelect(cwd);
      const product = this.productSelect.value || this.productsFor(cwd)[0] || '';
      if (!product) {
        toast('还没有 product 列表，请先点「采集 product 列表」', 'err', 3600);
        return;
      }
      const variant = this.variantInput.value.trim() || 'next-userdebug';
      localStorage.setItem(`dsh.variant.${cwd}`, variant);
      this.typeQuickCmd(`lunch ${product}-${variant}`);
    });
  }

  private async typeCdModule(): Promise<void> {
    await this.withBusy(async () => {
      const tab = this.connectedTab();
      if (!tab) return;
      const cwd = await this.resolveCwd(tab);
      if (!this.ensureProjectDir(cwd)) return;
      this.fillProductSelect(cwd);
      const dir = this.moduleInput.value.trim();
      if (!dir) {
        toast('请先填写模块目录', 'err');
        return;
      }
      localStorage.setItem(`dsh.moduleDir.${cwd}`, dir);
      this.typeQuickCmd(`cd ${dir}`);
    });
  }

  /**
   * 打开本地映射的编译输出目录：远端主目录(~)对应盘符根。
   * 如 /home/dsp/MTK/P6711EVF/a16 -> Z:\MTK\P6711EVF\a16\out\target\product
   */
  private async openOutDir(): Promise<void> {
    await this.withBusy(async () => {
      const tab = this.connectedTab();
      if (!tab) return;
      const cwd = await this.resolveCwd(tab);
      const drive = (this.driveInput.value.trim() || 'Z').replace(/:$/, '').toUpperCase();
      localStorage.setItem('dsh.explorerDrive', drive);
      // 远端主目录按主机记忆，没有则探测一次（$HOME）
      let home = localStorage.getItem(`dsh.home.${tab.config.host}`);
      if (!home) {
        home = await tab.probeHome();
        localStorage.setItem(`dsh.home.${tab.config.host}`, home);
      }
      const prefix = home.endsWith('/') ? home : home + '/';
      if (!cwd.startsWith(prefix)) {
        throw new Error(`当前目录不在远端主目录 ${home} 下，无法映射到 ${drive}: 盘`);
      }
      const rel = cwd.slice(prefix.length).replace(/\//g, '\\');
      const winPath = `${drive}:\\${rel}\\out\\target\\product`;
      const openErr = await api.openPath(winPath);
      if (openErr) {
        throw new Error(`打开失败：${openErr}`);
      }
      toast(`已打开：${winPath}`, 'ok', 3000);
    });
  }
}
