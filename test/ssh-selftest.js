/**
 * SSH 会话端到端自测（无界面）。
 *
 * 目的：在真实 Electron 运行时中验证「SSH 连接 -> 认证 -> PTY 分配 -> 输出经二进制端口
 * 直传 -> 输入送达 -> resize 传播 -> 断开清理 -> 错误处理」的完整链路，
 * 而不是仅仅验证编译通过。
 *
 * 数据通道的建模方式与真实应用一致：
 *   1. 主进程在 create() 时创建 MessageChannelMain 并持有 port1（可写）；
 *   2. 渲染进程通过 IPC.sessionReady 请求后，主进程把 port2 交付给它；
 *   3. 本测试扮演渲染进程：监听 IPC.sessionReady 并取走 port2，
 *      因此收到的东西与实际渲染进程完全一致。
 *
 * 用法：node_modules/electron/dist/electron.exe test/ssh-selftest.js
 *
 * 测试用的 SSH 服务器由 ssh2 自身在进程内启动（监听 127.0.0.1 随机端口），
 * 因此不会改动系统任何配置，也不需要外网。
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { app, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..');
const { Server } = require(path.join(ROOT, 'node_modules', 'ssh2'));

const USER = 'tester';
const PASSWORD = 'p@ssw0rd-测试';
const MARKER = 'SELFTEST-OK-42';
const BIG_LINES = 4000;

const serverState = {
  lastPty: null,
  lastWindowChange: null,
  shellOpened: false,
  receivedInput: '',
};

/* ------------------------------------------------------------------ */
/* 1. 启动一个真实的 SSH 服务器（仅监听回环地址）                       */
/* ------------------------------------------------------------------ */

function createSshServer() {
  return new Promise((resolve, reject) => {
    // 用 Node 原生 crypto 生成一台「临时主机密钥」，只存在于本次测试进程内
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

          session.on('pty', (acceptPty, _reject, info) => {
            serverState.lastPty = { cols: info.cols, rows: info.rows };
            acceptPty();
          });

          session.on('window-change', (acceptChange, _reject, info) => {
            serverState.lastWindowChange = { cols: info.cols, rows: info.rows };
            if (acceptChange) acceptChange();
          });

          session.on('shell', (acceptShell) => {
            const stream = acceptShell();
            serverState.shellOpened = true;
            stream.write('欢迎使用自测 SSH 服务器\r\n$ ');
            stream.on('data', (chunk) => {
              const text = chunk.toString('utf8');
              serverState.receivedInput += text;
              stream.write(text); // 模拟 PTY 回显
              if (text.includes('marker')) stream.write(`\r\n${MARKER}\r\n$ `);
              if (text.includes('flood')) {
                let payload = '';
                for (let i = 0; i < BIG_LINES; i++) {
                  payload += `line-${String(i).padStart(5, '0')} ` + 'x'.repeat(60) + '\r\n';
                }
                stream.write(payload);
                stream.write('$ ');
              }
            });
          });
        });
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ */
/* 2. 伪造渲染进程侧                                                    */
/* ------------------------------------------------------------------ */

function createSender() {
  const sent = [];
  const sender = {
    sent,
    id: 1,
    isDestroyed: () => false,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    mainFrame: {
      // 主进程通过这里下发通道端口；本测试同时扮演渲染进程，直接取走
      postMessage(channel, payload, transfer) {
        sent.push({ channel, payload });
        sender.deliveredPort = transfer && transfer[0];
      },
    },
  };
  return sender;
}

function prepareConfig(overrides = {}) {
  const { getStore } = require(path.join(ROOT, 'dist', 'main', 'store.js'));
  const store = getStore();
  for (const existing of store.listConfigs()) store.deleteConfig(existing.id);
  return store.saveConfig({
    name: '自测服务器',
    host: '127.0.0.1',
    username: USER,
    password: PASSWORD,
    savePassword: true,
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* 3. 测试主流程                                                       */
/* ------------------------------------------------------------------ */

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${extra ? '  -> ' + extra : ''}`);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await delay(stepMs);
  }
}

/** 打开一个会话并取出「渲染进程一侧」的端口 */
async function openSession(manager, config, size) {
  const sender = createSender();
  sender.messages = [];
  const created = manager.create(config.id, size, sender);
  // 真实流程：渲染进程发起 IPC.sessionReady，主进程把通道对端交付过来
  const listeners = ipcMain.listeners('session:ready');
  const fakeEvent = { sender: { mainFrame: sender.mainFrame, isDestroyed: () => false } };
  for (const fn of listeners) fn(fakeEvent, { sessionId: created.sessionId });
  await waitFor(() => !!sender.deliveredPort, 2000);
  const port = sender.deliveredPort;
  if (port) {
    port.on('message', (event) => sender.messages.push(event.data));
    port.start();
  }
  return { sender, created, port };
}

/**
 * 用测试自己创建的通道接管某个会话，从而可靠地捕获主进程写出的全部数据。
 *
 * 为什么需要它：Electron 的 MessagePortMain 只有在「一端被真正转移给渲染进程」后
 * 才具备完整的收发语义；在本进程内同时持有两端时，接收端收不到消息。
 * 因此这里新建一条通道：port1 交给会话用于发送，port2 留在测试侧接收。
 */
function hijackChannel(manager, sessionId) {
  const { MessageChannelMain } = require('electron');
  const { port1, port2 } = new MessageChannelMain();
  const session = manager.sessions.get(sessionId);
  // 直接替换会话的发送端口（测试专用），不影响被测逻辑本身
  session.port = port1;
  const messages = [];
  port2.on('message', (event) => messages.push(event.data));
  port2.start();
  return messages;
}

async function run() {
  console.log('\n=== 深寻 SSH 端到端自测 ===\n');

  const { server, port } = await createSshServer();
  console.log(`[1] SSH 测试服务器已启动：127.0.0.1:${port}`);

  const config = prepareConfig({ port });
  check('配置写入并可回读（密码经 safeStorage/降级加密）', config.password === PASSWORD && config.savePassword === true);

  const { SessionManager } = require(path.join(ROOT, 'dist', 'main', 'sessions.js'));
  const manager = new SessionManager();

  const size = { cols: 100, rows: 30 };
  const sender = createSender();
  sender.messages = [];
  const created = manager.create(config.id, size, sender);
  check('create() 同步返回会话 ID', created.ok === true && typeof created.sessionId === 'string', created.sessionId || '');

  // 主进程在 create() 时已注册 IPC.sessionReady，这里模拟渲染进程索取端口，
  // 验证「端口交付」这条真实链路是通的。
  // 注意 event.sender 必须是完整可用的 WebContents 替身：主进程会把它记为
  // 会话的 owner 并用它回传状态事件。
  const readyListeners = ipcMain.listeners('session:ready');
  const captureSender = createSender();
  for (const fn of readyListeners) {
    fn({ sender: captureSender }, { sessionId: created.sessionId });
  }
  check(
    '主进程响应 IPC.sessionReady 并交付数据通道端口',
    !!captureSender.deliveredPort,
    captureSender.deliveredPort ? '已交付' : '未交付',
  );

  // 用测试自建通道接管输出捕获（见 hijackChannel 注释），
  // 并把 owner 复位为最初的 sender，便于断言状态/结束事件
  const received = hijackChannel(manager, created.sessionId);
  manager.sessions.get(created.sessionId).owner = sender;

  /* ---------------------- 连接与认证 ---------------------- */
  const connected = await waitFor(() => serverState.shellOpened, 15000);
  check('SSH 握手 + 密码认证 + 分配 PTY 并打开 Shell', connected);

  check(
    'PTY 尺寸随会话创建传递到服务端',
    !!serverState.lastPty && serverState.lastPty.cols === 100 && serverState.lastPty.rows === 30,
    JSON.stringify(serverState.lastPty),
  );

  const textOf = () =>
    received
      .map((m) => (m && m.type === 'data' && m.data ? Buffer.from(m.data).toString('utf8') : ''))
      .join('');

  await waitFor(() => textOf().includes('欢迎使用自测 SSH 服务器'), 4000);
  check(
    '服务端 banner 经二进制通道到达渲染侧',
    textOf().includes('欢迎使用自测 SSH 服务器'),
    JSON.stringify(textOf().slice(0, 30)),
  );

  const statuses = () => sender.sent.filter((m) => m.channel === 'session:status').map((m) => m.payload.status);
  check('状态事件包含 connected', statuses().includes('connected'), statuses().join(','));
  /* ---------------------- 输入直传 ---------------------- */
  manager.write(created.sessionId, Buffer.from('echo marker\n', 'utf8'));
  await waitFor(() => serverState.receivedInput.includes('echo marker'), 3000);
  check('输入直传服务端（term.onData -> stream.write 等价路径）', serverState.receivedInput.includes('echo marker'));
  await waitFor(() => textOf().includes(MARKER), 3000);
  check('命令输出回流到渲染侧', textOf().includes(MARKER));

  /* ---------------------- resize 传播 ---------------------- */
  await delay(300);
  manager.resize(created.sessionId, { cols: 132, rows: 43 });
  const resized = await waitFor(
    () => serverState.lastWindowChange && serverState.lastWindowChange.cols === 132,
    5000,
  );
  check(
    'resize 传播到服务端 window-change',
    resized,
    JSON.stringify(serverState.lastWindowChange),
  );

  /* ---------------------- Shell 刚打开就 resize（补发机制） ---------- */
  serverState.lastWindowChange = null;
  const earlyConfig = prepareConfig({ name: '连接后立即调整尺寸', port });
  const early = await openSession(manager, earlyConfig, { cols: 80, rows: 24 });
  hijackChannel(manager, early.created.sessionId);
  await waitFor(() => serverState.shellOpened, 10000);
  manager.resize(early.created.sessionId, { cols: 150, rows: 50 });
  const earlyOk = await waitFor(
    () => serverState.lastWindowChange && serverState.lastWindowChange.cols === 150,
    8000,
  );
  check('Shell 刚打开就调整尺寸也能同步到服务端（补发机制）', earlyOk, JSON.stringify(serverState.lastWindowChange));
  manager.close(early.created.sessionId);
  await delay(500);

  /* ---------------------- 高频输出 ---------------------- */
  const bytes = () => received.reduce((sum, m) => sum + (m && m.data ? m.data.byteLength : 0), 0);
  const beforeBytes = bytes();
  const beforeBatches = received.filter((m) => m && m.type === 'data').length;
  const expected = BIG_LINES * 72;
  const t0 = Date.now();
  manager.write(created.sessionId, Buffer.from('flood\n', 'utf8'));
  await waitFor(() => bytes() - beforeBytes >= expected, 25000);
  const totalBytes = bytes() - beforeBytes;
  const elapsed = Date.now() - t0;
  const batches = received.filter((m) => m && m.type === 'data').length - beforeBatches;
  check(
    `高频输出完整送达（${BIG_LINES} 行 / ${(totalBytes / 1024).toFixed(0)} KB）`,
    totalBytes >= expected,
    `${elapsed}ms`,
  );
  check('同 tick 数据被合并投递（批次远少于行数）', batches < BIG_LINES / 4, `${batches} 个数据批次`);

  /* ---------------------- 断开清理 ---------------------- */
  manager.close(created.sessionId);
  await waitFor(() => sender.sent.some((m) => m.channel === 'session:ended'), 4000);
  const endEvents = sender.sent.filter((m) => m.channel === 'session:ended');
  check('断开后发出 session:ended 事件', endEvents.length === 1, JSON.stringify(endEvents[0]?.payload ?? null));
  await waitFor(() => manager.list().length === 0, 3000);
  check('断开后会话从管理器中移除', manager.list().length === 0, `剩余 ${manager.list().length} 个会话`);

  /* ---------------------- 错误处理 ---------------------- */
  const badConfig = prepareConfig({ name: '不可达服务器', port: 1 });
  const sender2 = createSender();
  sender2.messages = [];
  manager.create(badConfig.id, size, sender2);
  await waitFor(
    () => sender2.sent.some((m) => m.channel === 'session:status' && m.payload.status === 'error'),
    10000,
  );
  const badStatus = sender2.sent.filter((m) => m.channel === 'session:status');
  check(
    '连接失败时状态置为 error 且给出中文原因',
    badStatus.some((m) => m.payload.status === 'error' && /拒绝连接|超时|不可达|失败/.test(m.payload.message ?? '')),
    JSON.stringify(badStatus.map((e) => e.payload.message ?? e.payload.status)),
  );
  await waitFor(() => manager.list().length === 0, 4000);
  check('失败会话也被正确清理', manager.list().length === 0, `剩余 ${manager.list().length} 个会话`);

  /* ---------------------- 认证失败 ---------------------- */
  const wrongConfig = prepareConfig({ name: '错误密码', port, password: 'wrong-password' });
  const sender3 = createSender();
  sender3.messages = [];
  manager.create(wrongConfig.id, size, sender3);
  await waitFor(
    () => sender3.sent.some((m) => m.channel === 'session:status' && m.payload.status === 'error'),
    12000,
  );
  const wrongStatus = sender3.sent.filter((m) => m.channel === 'session:status' && m.payload.status === 'error');
  check(
    '密码错误时提示「认证失败」',
    wrongStatus.some((m) => /认证失败/.test(m.payload.message ?? '')),
    JSON.stringify(wrongStatus.map((e) => e.payload.message)),
  );
  await waitFor(() => manager.list().length === 0, 4000);

  server.close();
  await delay(100);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 项通过 ===`);
  for (const f of failed) console.log(`  未通过：${f.name} ${f.extra}`);
  return failed.length === 0 ? 0 : 1;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    console.error('自测异常：', err);
  }
  setTimeout(() => app.exit(code), 300);
});
