# 深寻 SSH（DeepSeek SSH）

Windows 桌面 SSH 客户端，用于替代 Xshell 的基本功能。图形化保存多台服务器配置，双击即可打开终端连接；
终端基于 xterm.js **WebGL 渲染器**，高频输出与大文件滚动不掉帧，拖拉窗口即时重排、无残影。

**不包含** SFTP、文件传输、端口转发、隧道、X11 转发等高级功能 —— 只把「连上去、好好用终端」这件事做到位。

---

## 一、技术方案

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 外壳 | Electron 28 + TypeScript | 主进程/预加载用 CommonJS 编译，渲染层由 Vite 打包 |
| SSH | `ssh2`（纯 TCP 直连） | **不调用系统 `ssh` 命令**；支持密码与 OpenSSH 私钥认证 |
| 终端 | `@xterm/xterm` + `addon-webgl` + `addon-fit` + `addon-search` | WebGL 渲染，失败时自动降级 Canvas / DOM |
| 终端数据 | **MessagePort 二进制直传** | 绕过 IPC 的 JSON 序列化与 UTF-8 字符串解码，见下文 |
| 配置存储 | 自研 JSON 存储 + Electron `safeStorage` | 密码用 Windows DPAPI 加密落盘，仅当前系统账户可解密 |
| 主机密钥 | 自研 known_hosts 指纹库 | 首次连接自动记录，指纹变化时拒绝连接（防中间人） |
| 界面 | 原生 TypeScript + CSS 变量主题 | 全中文，深色/高对比/Solarized/浅色四套主题 |

### 为什么终端数据不走普通 IPC

```
xterm  <-- MessagePort(二进制) -->  主进程  <-- ssh2 stream -->  远端
```

- 主进程在创建会话时即持有通道一端，**连接早期的 banner / 错误提示不会丢**；
- 远端数据以 `Buffer` → `Uint8Array` 直接投递给 `term.write()`，不做字符串解码、不逐行拼接、不加延迟；
- 同一 tick 内的多个数据块会合并成一条消息（`setImmediate` 批处理），减少跨进程序列化次数；
- 输入与窗口尺寸走的量极小，使用 `invoke` 通道，可靠优先。

### 消除缩放残影的三道措施

1. `allowTransparency: false`：关闭透明通道，WebGL 合成更快更清晰；
2. `ResizeObserver` + `requestAnimationFrame` 合并抖动，`fit()` 后由 `term.onResize` 调用
   `stream.setWindow(rows, cols, 0, 0)` 通知远端 PTY；
3. 缩放停止 140ms 后**重建 WebGL 渲染器**（丢弃并重建纹理图集），这是 Windows 上根治
   「拖拽缩放后残留旧尺寸字形」的手段；另监听 canvas 上下文丢失自动降级。

### 其他可靠性设计

- **刚连上就拖窗口**：服务端是在 PTY 分配之后才挂 `window-change` 监听的，存在极短时间差。
  会话在 Shell 打开后的短时间内会重发窗口尺寸（最多 6 次 / 约 0.9s），收到远端输出即停止。
- **界面重载**：`Ctrl+R` 重新加载界面会先断开该窗口的全部 SSH 连接，避免留下无法操作的僵尸连接。
- **关闭标签**：先通知主进程结束会话，再销毁前端资源，连接一定会被释放。

---

## 二、项目结构

```
ssh-deepseek/
├─ package.json / tsconfig*.json / vite.config.mts / electron-builder.yml
├─ src/
│  ├─ main/                     # 主进程
│  │  ├─ index.ts               # 入口：窗口、中文菜单、IPC 路由、生命周期
│  │  ├─ sessions.ts            # SSH 会话管理、二进制通道、尺寸重试、错误中文化
│  │  ├─ store.ts               # JSON 配置存储 + safeStorage 密码加解密 + 主机指纹库
│  │  ├─ ipc.ts                 # 通道常量（主/预加载/渲染共用）
│  │  └─ types.ts               # 共享数据结构与默认设置
│  ├─ preload/index.ts          # contextBridge 桥接（含 MessagePort 通道封装）
│  └─ renderer/
│     ├─ index.html
│     ├─ styles/{base,layout,terminal,dialog}.css
│     └─ src/
│        ├─ main.ts             # 界面装配、快捷键、状态栏、菜单命令分发
│        ├─ terminal.ts         # 终端标签：xterm + WebGL + fit + search + 输入输出
│        ├─ tabs.ts             # 多标签管理（常驻 DOM，切换零重建）
│        ├─ sidebar.ts          # 配置列表、搜索、右键菜单
│        ├─ config-dialog.ts    # 配置编辑 / 设置 / 快捷键 / 详情 对话框
│        ├─ themes.ts           # 四套终端 + 界面主题
│        ├─ context-menu.ts / dialogs.ts / toast.ts / util.ts / api.ts
└─ test/
   ├─ ssh-selftest.js           # 会话层端到端自测（18 项）
   └─ gui-e2e.js                # 界面端到端自测（21 项，附截图）
```

---

## 三、依赖

**运行时**：`@xterm/xterm`、`@xterm/addon-webgl`、`@xterm/addon-fit`、`@xterm/addon-search`、
`@xterm/addon-canvas`（WebGL 降级用）、`ssh2`

**开发**：`electron`、`electron-builder`、`typescript`、`vite`、`@types/node`、`@types/ssh2`

> 未使用 `electron-store`：其 v10 起为 ESM-only，与 CJS 主进程互操作成本高，
> 这里用等价的轻量实现（原子写入 + 内存缓存 + 60ms 写入合并），行为完全可控。

---

## 四、开发与构建

```bash
npm install            # 安装依赖
npm run dev            # 构建并启动应用
npm run build          # 构建 main / preload / renderer
npm run typecheck      # 三个子项目的类型检查
npm test               # 构建 + 会话层 / 界面 / 首页按钮 三套端到端自测
npm run test:icon      # 校验打包产物图标（需先 npm run dist）

npm run dist           # 打包 NSIS 安装包 + 绿色版（输出到 release/）
npm run dist:portable  # 只打绿色版
```

> 若在受限环境（如沙箱）中 `npm install` 因子进程权限失败，可用
> `npm install --ignore-scripts`，再单独执行 `node node_modules/electron/install.js` 下载 Electron 运行时。

### 图标是怎么进到 exe 里的

electron-builder 自带的资源改写（`signAndEditExecutable`）需要下载 winCodeSign 并解压其中的
macOS 符号链接，在「非管理员且未开启开发者模式」的 Windows 上会直接失败。因此这里：

- `signAndEditExecutable: false`：关闭 electron-builder 的资源改写；
- `afterPack: scripts/after-pack.js`：打包完成后用 **rcedit** 把 `build/icon.ico`
  与版本信息写进 `深寻SSH.exe`（rcedit 从 electron-builder 缓存或本项目缓存中查找）；
- `extraResources`：把 `build/icon.ico` 复制到 `resources/icon.ico`，供主进程运行时
  显式设置窗口与任务栏图标；
- `win.icon` + `nsis.installerIcon/uninstallerIcon`：安装包、卸载器与快捷方式图标。

三处都验证过：`npm run test:icon` 会逐字节比对 exe 内嵌图标与 `build/icon.ico`，
并校验运行时确实解析到 `resources/icon.ico`。

### 打包产物

`npm run dist` 会在 `release/` 生成：

- `DeepSeekSSH-1.0.0-setup.exe` —— NSIS 安装包（可选安装目录、创建桌面与开始菜单快捷方式）
- `DeepSeekSSH-1.0.0-portable.exe` —— 绿色版，双击即用
- `win-unpacked/` —— 免安装目录（可直接运行其中的 `深寻SSH.exe`）

> 替换过 exe 后如果图标没变化，是 Windows 图标缓存导致的：把 exe 解压/复制到新目录，
> 或清理图标缓存（`ie4uinit.exe -show`）即可。

---

## 五、使用说明

### 配置与连接

1. 点击左上角 **＋ 新建**（或 `Ctrl+N`）填写名称、主机、端口、用户名、密码；
   勾选「记住密码」后密码会以 DPAPI 加密保存在本机。
2. **双击左侧配置**即可打开终端标签并连接；右键配置可编辑 / 复制 / 删除 / 查看详情 / 复制 `ssh` 命令。
3. 搜索框支持按名称、主机、用户名、端口过滤，方向键可切换选中项。

### 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+N` | 新建配置 |
| `Ctrl+R` | 重新连接当前标签 |
| `Ctrl+W` | 关闭当前标签（并断开 SSH） |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | 复制 / 粘贴（`Ctrl+C` 仍发送 SIGINT，`Ctrl+V` 仍发送 0x16） |
| `Shift+Insert` | 粘贴（Windows 传统习惯） |
| `Ctrl+Shift+A` | 全选终端内容 |
| `Ctrl+Shift+F` | 终端内查找（Enter 下一个 / Shift+Enter 上一个） |
| `Ctrl+K` | 清空视口与回看缓冲 |
| `Ctrl+ +` / `Ctrl+ -` / `Ctrl+0` | 放大 / 缩小 / 重置字号 |
| `Ctrl+Tab`、`Ctrl+1..9` | 切换标签 |
| `Ctrl+,` | 打开设置 |
| 鼠标右键 | 终端操作菜单（复制、粘贴、查找、重连、断开、关闭、字号） |

### 主机密钥与安全

- 首次连接自动记录主机指纹并打印 `SHA256:...`；
- 之后若指纹变化会**拒绝连接**并提示，确认服务器重装后可在 *设置 → 已信任的主机指纹* 中删除该记录；
- 密码使用 Electron `safeStorage`（Windows DPAPI）加密；若系统不支持加密会降级保存并在日志中告警。

### 断线后的行为

连接失败或远端断开时，错误信息会以红色直接打印在终端里（含中文原因，如
「目标认证失败：用户名、密码或私钥不正确」「目标主机拒绝连接（端口未开放或服务未启动）」），
标签保留为「已断开」状态，可随时点「重连」或 `Ctrl+R` 恢复。

---

## 六、自测

仓库自带四套端到端自测，前三套在**真实 Electron 运行时**中运行，且自带一台
`ssh2` 临时 SSH 服务器（随机端口、临时主机密钥，仅监听 127.0.0.1），不会改动系统配置。

```bash
npm run test:ssh   # 会话层：认证、PTY、数据直传、resize、高频输出、断开清理、错误处理（18 项）
npm run test:gui   # 界面层：配置列表、双击连接、终端渲染、缩放、主题、多标签、清理（21 项，输出截图）
npm run test:ui    # 交互层：首页按钮命中测试（是否被遮挡）、系统级鼠标点击、欢迎页层级（6 项）
npm run test:icon  # 打包产物：exe 内嵌图标逐字节比对、版本信息、随包图标、运行时解析（10 项，需先打包）
```

`test/screenshots/` 下会生成连接后、缩放后、浅色主题、多标签共四张界面截图，可直接肉眼确认渲染结果。

覆盖的关键场景：

- 密码认证、PTY 尺寸协商、banner 输出经二进制通道到达前端；
- 终端输入往返（`ls` 输出真的被渲染出来）；
- `window-change` 传播，含「刚连上就拖窗口」的补发机制；
- 4000 行 / 285 KB 高频输出完整送达，且被合并为极少量批次（实测约 50ms）；
- 断开后 `session:ended` 事件、会话清理、连接失败与认证失败的中文提示；
- 界面：缩放后行列数变化且内容不丢、主题持久化、多标签与关闭回收、重载不泄漏连接；
- 交互：按钮**命中测试**（防止被绝对定位元素遮挡而点不动）、系统级鼠标点击、欢迎页层级关系；
- 图标：三个 exe 的内嵌图标与 `build/icon.ico` 逐字节一致、版本信息属于本应用、
  运行时从 `resources/icon.ico` 加载。
