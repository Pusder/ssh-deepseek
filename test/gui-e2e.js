/**
 * 界面端到端自测：启动真实应用（dist/main/index.js），连接真实的 SSH 服务器，
 * 驱动界面完成「双击配置 -> 打开终端 -> 执行命令 -> 调整窗口大小 -> 切换主题 -> 多标签」，
 * 并截图落盘，用于确认 xterm 真的把远端输出渲染出来了。
 *
 * 用法：node_modules/electron/dist/electron.exe test/gui-e2e.js
 * 截图输出：test/screenshots/*.png
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const USER_DATA = path.join(__dirname, '.userdata-gui');
const SHOTS = path.join(__dirname, 'screenshots');
const { Server } = require(path.join(ROOT, 'node_modules', 'ssh2'));

const USER = 'demo';
const PASSWORD = 'demo-pass';
const TERM_PROMPT = '$ ';

/**
 * 实时模式：不再使用内置测试服务器，而是连接真实服务器。
 * 用法示例：
 *   $env:LIVE='1'; $env:LIVE_HOST='127.0.0.1'; $env:LIVE_USER='user1'; $env:LIVE_PASS='sdfsdf'
 *   node_modules/electron/dist/electron.exe test/gui-e2e.js
 * 此时会跳过依赖内置 shell 应答的断言（主题、多标签等仍会执行）。
 */
const LIVE = process.env.LIVE === '1';
const LIVE_HOST = process.env.LIVE_HOST || '127.0.0.1';
const LIVE_PORT = Number(process.env.LIVE_PORT || 22);
const LIVE_USER = process.env.LIVE_USER || 'user1';
const LIVE_PASS = process.env.LIVE_PASS || 'sdfsdf';
const LIVE_CMD = process.env.LIVE_CMD || 'ls';

const serverState = { receivedInput: '' };

// 使用独立的数据目录，避免污染真实用户的配置
app.setPath('userData', USER_DATA);
app.setName('deepseek-ssh');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${extra ? '  -> ' + extra : ''}`);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await delay(stepMs);
  }
}

/* ------------------------- 测试用 SSH 服务器 ------------------------- */
function createSshServer() {
  return new Promise((resolve, reject) => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASSWORD) ctx.accept();
        else ctx.reject(['password']);
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (acceptPty) => acceptPty());
          session.on('window-change', (acceptChange) => acceptChange && acceptChange());
          session.on('shell', (acceptShell) => {
            const stream = acceptShell();
            stream.write(
              '\x1b[1;32m=== 演示服务器连接成功 ===\x1b[0m\r\n' +
                '\x1b[36m主机\x1b[0m : demo.example.internal\r\n' +
                '\x1b[36m系统\x1b[0m : Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-105-generic x86_64)\r\n' +
                '\x1b[36m负载\x1b[0m : 0.08 0.12 0.09\r\n\r\n' +
                'Last login: Fri Sep 11 15:20:41 2026 from 10.0.0.5\r\n' +
                TERM_PROMPT,
            );
            stream.on('data', (chunk) => {
              const text = chunk.toString('utf8');
              serverState.receivedInput += text;
              stream.write(text); // 回显
              if (text.includes('ls')) {
                stream.write(
                  'total 28\r\n' +
                    'drwxr-xr-x  5 demo demo 4096 Sep 11 15:20 \x1b[1;34m.\x1b[0m\r\n' +
                    'drwxr-xr-x  3 root root 4096 Sep  1 09:00 \x1b[1;34m..\x1b[0m\r\n' +
                    '-rw-r--r--  1 demo demo  220 Sep  1 09:00 .bash_logout\r\n' +
                    '-rw-r--r--  1 demo demo 3771 Sep  1 09:00 .bashrc\r\n' +
                    'drwxr-xr-x  2 demo demo 4096 Sep 11 15:19 \x1b[1;34mproject\x1b[0m\r\n',
                );
              }
              if (text.includes('neofetch')) {
                stream.write('\x1b[35m  OS\x1b[0m: Ubuntu 22.04 x86_64\r\n\x1b[35mCPU\x1b[0m: 4 x vCPU @ 2.5GHz\r\n');
              }
              // 每次回车都回一个提示符，模拟真实 shell
              if (text.includes('\r') || text.includes('\n')) stream.write(TERM_PROMPT);
            });
          });
        });
      });
    });

    server.on('error', reject);
    // 端口 0 = 由系统分配空闲端口，避免与上一次残留的测试进程冲突
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------ 主流程 ------------------------------ */
async function run(port) {
  console.log('\n=== 深寻 SSH 界面端到端自测 ===\n');

  // 1) 先写配置（密码经 safeStorage 加密），模拟「用户已保存过服务器」
  const { getStore } = require(path.join(ROOT, 'dist', 'main', 'store.js'));
  const store = getStore();
  for (const c of store.listConfigs()) store.deleteConfig(c.id);
  const account = LIVE ? { user: LIVE_USER, pass: LIVE_PASS, host: LIVE_HOST, port: LIVE_PORT } : { user: USER, pass: PASSWORD, host: '127.0.0.1', port };
  if (LIVE) store.forgetHostKey(account.host, account.port);
  store.saveConfig({
    name: LIVE ? `${account.user}@${account.host}` : '演示服务器',
    host: account.host,
    port: account.port,
    username: account.user,
    password: account.pass,
    savePassword: true,
    note: LIVE ? '实时验收' : '自测用配置',
  });
  store.saveConfig({
    name: LIVE ? `${account.user}@${account.host} 2` : '演示服务器 2',
    host: account.host,
    port: account.port,
    username: account.user,
    password: account.pass,
    savePassword: true,
  });
  check('已写入测试配置（密码加密保存）', store.listConfigs().length === 2);

  // 2) 启动真实应用主进程（主进程的 warn/error 落盘，便于排查）
  const diagFile = path.join(__dirname, 'main-diag.log');
  fs.writeFileSync(diagFile, '');
  const origWarn = console.warn;
  const origError = console.error;
  const toFile = (prefix) => (...args) => {
    try {
      fs.appendFileSync(diagFile, `${prefix} ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}\n`);
    } catch {
      /* ignore */
    }
  };
  console.warn = toFile('[warn]');
  console.error = toFile('[error]');
  require(path.join(ROOT, 'dist', 'main', 'index.js'));
  console.warn = origWarn;
  console.error = origError;

  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 10000);
  check('应用窗口已创建', !!win);
  if (!win) return;

  await waitFor(() => !win.webContents.isLoading(), 10000);
  // 测试期间必须让窗口真实可见并获得焦点，否则 Chromium 会节流渲染，
  // 导致 ResizeObserver 不触发、capturePage 报「display surface not available」。
  win.show();
  win.focus();
  win.setAlwaysOnTop(true);
  const waitVisible = await waitFor(() => win.isVisible() && !win.webContents.isOffscreen(), 5000);
  check('测试窗口可见（保证渲染不被节流）', win.isVisible() === true, `visible=${win.isVisible()} ready=${!!waitVisible}`);
  await delay(1500); // 等待渲染层初始化 xterm 与 WebGL

  const run_js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code, true);
    } catch (err) {
      console.log(`  [提示] 渲染层脚本执行失败：${err.message}\n         脚本：${code.trim().slice(0, 120)}`);
      const consoleErrors = await win.webContents
        .executeJavaScript(`JSON.stringify(window.__lastError || null)`, true)
        .catch(() => 'n/a');
      console.log('  [提示] 渲染层最近错误：', consoleErrors);
      return undefined;
    }
  };

  /** 点击左侧第 index 个配置（等价于用户双击） */
  const dblclickConfig = async (index) => {
    const result = await run_js(`
      (() => {
        try {
          const items = document.querySelectorAll('#config-list .config-item');
          const el = items[${index}];
          if (!el) return 'missing:' + items.length;
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return 'ok';
        } catch (e) {
          return 'error:' + (e && e.message);
        }
      })()
    `);
    if (result !== 'ok') console.log(`  [提示] dblclickConfig(${index}) => ${result}`);
    return result;
  };

  /** 截屏（窗口不可捕获时跳过，不影响功能断言） */
  const capture = async (name) => {
    try {
      fs.mkdirSync(SHOTS, { recursive: true });
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(SHOTS, name), image.toPNG());
      return name;
    } catch (err) {
      console.log(`  [提示] 截图 ${name} 失败：${err.message}`);
      return null;
    }
  };

  const bridgeOk = await run_js(`window.dshSsh ? 'bridge-ok' : 'no-bridge'`);
  check('渲染进程成功拿到 preload 桥接对象', bridgeOk === 'bridge-ok', bridgeOk);

  // 3) 左侧配置列表
  const listCount = await run_js(`document.querySelectorAll('#config-list .config-item').length`);
  check('左侧列表渲染出配置项', listCount === 2, `${listCount} 项`);
  const listText = await run_js(
    `document.querySelector('#config-list .config-item').innerText.replace(/\\n/g,' | ')`,
  );
  check(
    '列表显示名称/主机/用户',
    listText.includes(account.user) && listText.includes(`${account.host}:${account.port}`),
    listText,
  );

  // 4) 双击配置触发连接（等价于用户操作路径）
  await dblclickConfig(0);
  const opened = await waitFor(() => run_js(`document.querySelectorAll('.term-pane').length > 0`), 8000);
  check('双击配置后打开了终端标签', !!opened);

  // 5) 等待连接完成，并确认远端输出进入了终端缓冲区
  const screenText = () => run_js(`window.__dshE2E ? window.__dshE2E.screenText() : ''`);
  const connected = await waitFor(async () => {
    const status = await run_js(`window.__dshE2E.state() && window.__dshE2E.state().status`);
    return status === 'connected';
  }, 20000);
  check('会话建立并进入已连接状态', connected === true, String(connected));

  const bannerText = LIVE ? 'Last login' : '演示服务器连接成功';
  const banner = await waitFor(async () => {
    const text = await screenText();
    return text && text.includes(bannerText) ? text : '';
  }, LIVE ? 25000 : 10000);
  check(`远端输出已渲染到 xterm 屏幕（含「${bannerText}」）`, !!banner, banner ? '' : '（无）');

  const stats = JSON.parse(await run_js(`JSON.stringify(window.__dshE2E.stats())`));
  check('输出数据经 MessagePort 通道送达', stats.frames > 0 && stats.bytes > 0, JSON.stringify(stats));

  const rendererName = await run_js(`document.getElementById('status-renderer').textContent`);
  check('使用 WebGL 渲染器', /WebGL/.test(rendererName), rendererName);

  const statusText = await run_js(`document.getElementById('status-conn').innerText.trim()`);
  check('状态栏显示已连接', /已连接/.test(statusText), statusText);

  // 6) 在终端里真正执行一条命令（xterm onData -> SSH -> 回显 -> 渲染）
  await run_js(`
    const textarea = document.querySelector('.term-pane.active textarea');
    textarea.focus();
    true;
  `);
  await delay(250);

  /** 经渲染层真实输入路径发送（term.paste 走的就是 term.onData） */
  const sendViaTerminal = async (cmd) => {
    await run_js(`window.__dshE2E.sendInput(${JSON.stringify(cmd + '\r')}); true;`);
  };
  /** 模拟真实按键的输入路径（triggerDataEvent，不经过 paste 的换行改写） */
  const sendViaKeystrokes = async (cmd) => {
    await run_js(`window.__dshE2E.typeInput(${JSON.stringify(cmd + '\r')}); true;`);
  };
  /** 经会话通道直接发送（绕过 xterm，用于对照） */
  const sendViaChannel = async (cmd) => {
    const sid = await run_js(`window.__dshE2E.sessionId()`);
    await run_js(
      `window.dshSsh.writeSession(${JSON.stringify(sid)}, new TextEncoder().encode(${JSON.stringify(cmd + '\r')})).then(() => true)`,
    );
  };

  /**
   * 输入路径验证：经渲染层真实输入路径发送命令，确认远端真的执行了它。
   * 说明：pasted 文本在远端会回显成两行（一行原文、一行回显），
   * 因此这里只判断「标记是否出现在屏幕文本中」。
   */
  const cmdMark = LIVE ? 'vbox' : 'project';
  const statsBefore = JSON.parse(await run_js(`JSON.stringify(window.__dshE2E.stats())`));

  // 等待登录脚本结束（输出静默一段时间）再发命令，模拟真实用户操作节奏
  let lastBytes = -1;
  for (let i = 0; i < 40; i++) {
    const now = JSON.parse(await run_js(`JSON.stringify(window.__dshE2E.stats())`)).bytes;
    if (now === lastBytes && now > 0) break;
    lastBytes = now;
    await delay(300);
  }
  await delay(1200);

  const beforeCmd = await screenText();
  await sendViaTerminal(LIVE_CMD);

  let afterLs = await waitFor(async () => {
    const text = await screenText();
    return text && text.includes(cmdMark) ? text : '';
  }, LIVE ? 20000 : 12000);

  if (!afterLs) {
    // 兜底：若粘贴路径未生效（例如窗口未获得系统焦点），改用按键路径再试一次
    console.log('  [诊断] 粘贴路径未得到结果，改用按键路径重试');
    await sendViaKeystrokes(LIVE_CMD);
    afterLs = await waitFor(async () => {
      const text = await screenText();
      return text && text.includes(cmdMark) ? text : '';
    }, LIVE ? 20000 : 12000);
  }

  const statsAfter = JSON.parse(await run_js(`JSON.stringify(window.__dshE2E.stats())`));
  if (!afterLs) {
    console.log('  [诊断] 输入后屏幕：', JSON.stringify((await screenText()).slice(-600)));
    console.log('  [诊断] 数据统计 发送前/后：', JSON.stringify(statsBefore), '/', JSON.stringify(statsAfter));
    console.log('  [诊断] 服务端收到：', JSON.stringify(serverState.receivedInput));
  }
  check(`终端输入经 SSH 往返并显示执行结果（含「${cmdMark}」）`, !!afterLs, afterLs ? '' : '（无）');
  if (LIVE) {
    console.log('\n----- 实际屏幕内容（执行 ' + LIVE_CMD + ' 后）-----');
    console.log(String(afterLs || beforeCmd).slice(-1500));
    console.log('-------------------------------------------\n');
  }
  if (!LIVE) {
    check(
      '服务端确实收到了终端输入',
      serverState.receivedInput.includes('ls'),
      JSON.stringify(serverState.receivedInput.slice(0, 40)),
    );
  }

  // 7) 截图：验证 xterm 真的画出内容
  await capture('01-connected-dark.png');

  // 8) 快速改变窗口大小：终端应即时跟随且行列数变化
  const sizeOf = async () => {
    const json = await run_js(`JSON.stringify(window.__dshE2E.state())`);
    const state = JSON.parse(json);
    return state ? `${state.cols}x${state.rows}` : 'none';
  };
  const sizeBefore = await sizeOf();
  win.setSize(980, 620);
  await delay(600);
  win.setSize(1420, 900);
  const grew = await waitFor(async () => (await sizeOf()) !== sizeBefore, 8000);
  const sizeAfter = await sizeOf();
  check('调整窗口后终端行列数自动跟随', grew && sizeAfter !== sizeBefore, `${sizeBefore} -> ${sizeAfter}`);

  const afterResize = await screenText();
  check(
    '缩放后终端内容仍在（无清屏/丢失）',
    LIVE ? afterResize.length > 0 : afterResize.includes('演示服务器连接成功'),
  );
  await capture('02-resized.png');

  // 9) 切换主题：保存设置后重载界面，验证主题在启动时生效并被持久化
  await run_js(`window.dshSsh.saveSettings({ theme: 'light', fontSize: 16 }).then(() => true)`);
  await delay(300);
  win.webContents.reload();
  await delay(2500);
  const themeApplied = await run_js(`document.body.dataset.theme`);
  check('切换主题后重载界面主题已生效（设置已持久化）', themeApplied === 'light', themeApplied);
  await capture('03-theme-light.png');

  // 恢复深色主题
  await run_js(`window.dshSsh.saveSettings({ theme: 'dark' }).then(() => true)`);
  await delay(200);

  // 10) 多标签：重载后先连第一个配置，再用第二个配置新开一个标签
  const readyList = await waitFor(
    () => run_js(`document.querySelectorAll('#config-list .config-item').length === 2`),
    10000,
  );
  if (!readyList) console.log('  [提示] 重载后配置列表尚未就绪');
  await dblclickConfig(0);
  await waitFor(() => run_js(`document.querySelectorAll('#tab-list .tab').length === 1`), 10000);
  await delay(800);
  await dblclickConfig(1);
  const listDebug = await run_js(
    `JSON.stringify(Array.from(document.querySelectorAll('#config-list .config-item')).map(i => i.dataset.id + '/' + (i.querySelector('.config-name') || {}).textContent))`,
  );
  console.log('  [诊断] 配置列表：', listDebug, '| 标签数：', await run_js(`document.querySelectorAll('#tab-list .tab').length`));
  const twoTabs = await waitFor(() => run_js(`document.querySelectorAll('#tab-list .tab').length >= 2`), 15000);
  const tabCount = await run_js(`document.querySelectorAll('#tab-list .tab').length`);
  check('可同时打开多个终端标签', !!twoTabs && tabCount >= 2, `${tabCount} 个标签`);

  // 11) 标签切换
  await run_js(`const t = document.querySelectorAll('#tab-list .tab'); if (t[0]) t[0].click(); true;`);
  await delay(600);
  const activeTitle = await run_js(`window.__dshE2E.state() && window.__dshE2E.state().title`);
  check('标签切换后当前标签同步更新', !!activeTitle, String(activeTitle ?? ''));
  await capture('04-multi-tab.png');

  // 12) 关闭标签应断开对应 SSH 连接
  await run_js(`const b = document.querySelector('.tab.active .tab-close'); if (b) b.click(); true;`);
  await delay(1500);
  const remaining = await run_js(`document.querySelectorAll('#tab-list .tab').length`);
  check('关闭标签后标签被移除', remaining === tabCount - 1, `${remaining} 个标签`);

  // 收尾：关闭全部标签，检查主进程无残留会话
  const beforeClose = await run_js(`window.dshSsh.listSessions().then(s => JSON.stringify(s))`);
  console.log('  [诊断] 关闭标签前的会话：', beforeClose);
  await run_js(`document.querySelectorAll('.tab .tab-close').forEach(b => b.click()); true;`);
  const cleaned = await waitFor(async () => {
    const n = await run_js(`window.dshSsh.listSessions().then(s => s.length)`);
    return n === 0;
  }, 8000);
  const sessionsLeft = await run_js(`window.dshSsh.listSessions().then(s => s.length)`);
  if (sessionsLeft !== 0) {
    console.log('  [诊断] 残留会话：', await run_js(`window.dshSsh.listSessions().then(s => JSON.stringify(s))`));
  }
  check('关闭全部标签后主进程无残留 SSH 会话', cleaned && sessionsLeft === 0, `剩余 ${sessionsLeft} 个`);
}

app.whenReady().then(async () => {
  let code = 1;
  let server = null;
  try {
    const started = await createSshServer();
    server = started.server;
    console.log(`[1] 演示 SSH 服务器已启动：127.0.0.1:${started.port}`);
    await run(started.port);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 项通过 ===`);
    for (const f of failed) console.log(`  未通过：${f.name} ${f.extra}`);
    console.log(`截图目录：${SHOTS}`);
    code = failed.length === 0 ? 0 : 1;
  } catch (err) {
    console.error('界面自测异常：', err);
  }
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => app.exit(code), 500);
});
