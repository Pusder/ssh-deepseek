/**
 * 专项排查：首页「新建第一个配置」按钮点击是否被遮挡 / 监听是否生效。
 * 用法：node_modules/electron/dist/electron.exe test/welcome-click-test.js
 */
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
app.setPath('userData', path.join(__dirname, '.userdata-welcome'));
app.setName('deepseek-ssh');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${extra ? '  -> ' + extra : ''}`);
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    require(path.join(ROOT, 'dist', 'main', 'index.js'));
    const win = await new Promise((resolve) => {
      const t = setInterval(() => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w) {
          clearInterval(t);
          resolve(w);
        }
      }, 100);
    });
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    win.show();
    win.focus();
    await delay(1500);

    const run_js = async (codeStr) => {
      try {
        return await win.webContents.executeJavaScript(codeStr, true);
      } catch (err) {
        return `__ERROR__:${err.message}`;
      }
    };

    // 1) 按钮是否存在、是否可见、几何位置
    const info = await run_js(`
      (() => {
        const btn = document.getElementById('welcome-new');
        if (!btn) return JSON.stringify({ exists: false });
        const r = btn.getBoundingClientRect();
        const cs = getComputedStyle(btn);
        const welcome = document.getElementById('welcome');
        const wcs = getComputedStyle(welcome);
        return JSON.stringify({
          exists: true,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents, zIndex: cs.zIndex,
          welcomeDisplay: wcs.display, welcomePointerEvents: wcs.pointerEvents, welcomeHidden: welcome.classList.contains('hidden'),
          disabled: btn.disabled,
          text: btn.textContent,
        });
      })()
    `);
    console.log('  [诊断] 按钮几何与样式：', String(info));
    check('首页按钮存在且可见', String(info).includes('"exists":true') && !String(info).includes('"display":"none"'));

    // 2) 命中测试：按钮中心点上真正接收点击的是谁
    const hit = await run_js(`
      (() => {
        const btn = document.getElementById('welcome-new');
        if (!btn) return 'no-button';
        const r = btn.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const chain = [];
        let el = top;
        while (el && chain.length < 6) { chain.push(el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ').join('.') : '')); el = el.parentElement; }
        return JSON.stringify({ cx: Math.round(cx), cy: Math.round(cy), top: chain[0], chain });
      })()
    `);
    console.log('  [诊断] 中心点命中：', String(hit));
    check(
      '按钮中心点没有被其它元素遮挡',
      String(hit).includes('BUTTON#welcome-new'),
      String(hit),
    );

    // 3) 用真实鼠标事件序列点击（mousedown/mouseup/click）并观察是否弹出对话框
    const before = await run_js(`document.querySelectorAll('.modal-backdrop').length`);
    await run_js(`
      (() => {
        const btn = document.getElementById('welcome-new');
        const r = btn.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
        btn.dispatchEvent(new MouseEvent('mousedown', opts));
        btn.dispatchEvent(new MouseEvent('mouseup', opts));
        btn.dispatchEvent(new MouseEvent('click', opts));
        return true;
      })()
    `);
    await delay(600);
    const afterDispatch = await run_js(`document.querySelectorAll('.modal-backdrop').length`);
    check('派发点击事件能打开对话框', afterDispatch > before, `弹窗数 ${before} -> ${afterDispatch}`);
    if (afterDispatch > before) {
      await run_js(`(document.querySelector('.modal-close') || {click(){}}).click(); true;`);
      await delay(300);
    }

    // 4) 用 sendInputEvent 模拟系统级鼠标点击（最接近真人）
    const before2 = await run_js(`document.querySelectorAll('.modal-backdrop').length`);
    const rect = JSON.parse(String(info)).rect;
    const x = Math.round(rect.x + rect.w / 2);
    const y = Math.round(rect.y + rect.h / 2);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await delay(700);
    const afterReal = await run_js(`document.querySelectorAll('.modal-backdrop').length`);
    check('系统级鼠标点击能打开对话框', afterReal > before2, `弹窗数 ${before2} -> ${afterReal}（点击坐标 ${x},${y}）`);

    // 5) 监听器是否真的挂上了（用 poke 探针）
    const poke = await run_js(`
      (() => {
        const btn = document.getElementById('welcome-new');
        let fired = false;
        const probe = () => { fired = true; };
        btn.addEventListener('click', probe);
        btn.click();
        btn.removeEventListener('click', probe);
        return fired;
      })()
    `);
    check('按钮的 click 事件能被触发（监听机制本身可用）', poke === true, String(poke));

    // 6) 防回归：欢迎页显示时必须能点；有标签隐藏后，终端区域必须能正常命中
    await run_js(`(document.querySelector('.modal-close') || {click(){}}).click(); true;`);
    await delay(300);
    const tabInfo = await run_js(`
      (() => {
        const stack = document.getElementById('terminal-stack');
        const welcome = document.getElementById('welcome');
        return JSON.stringify({
          welcomeHidden: welcome.classList.contains('hidden'),
          welcomeDisplay: getComputedStyle(welcome).display,
          stackZ: getComputedStyle(stack).zIndex,
          welcomeZ: getComputedStyle(welcome).zIndex,
        });
      })()
    `);
    console.log('  [诊断] 层级关系：', String(tabInfo));
    check(
      '欢迎页层级高于终端容器（否则按钮会被遮挡）',
      Number(JSON.parse(String(tabInfo)).welcomeZ) > Number(JSON.parse(String(tabInfo)).stackZ),
      String(tabInfo),
    );

    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 项通过 ===`);
    for (const f of failed) console.log(`  未通过：${f.name} ${f.extra}`);
    code = failed.length === 0 ? 0 : 1;
  } catch (err) {
    console.error('排查脚本异常：', err);
  }
  setTimeout(() => app.exit(code), 400);
});
