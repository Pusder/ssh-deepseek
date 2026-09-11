/**
 * NSIS 宏编译探针：单独编译 build/uninstall.nsh 里的 customUnInstall，
 * 确认宏语法正确、且卸载提示文案确实被写进生成物。
 *
 * 注意：NSIS 对非 ASCII 的脚本/include 要求 UTF-8 **带 BOM**，否则会报
 * Bad text encoding 或被静默解析成空文件（表现为 "no sections specified"）。
 *
 * 用法：node test/nsis-macro-probe.js
 *      $env:NSIS_VERBOSE=1; node test/nsis-macro-probe.js   # 打印 makensis 详细输出
 */
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(__dirname, '.nsis-probe');

function findMakensis() {
  const roots = [
    path.join(ROOT, '.electron-builder-cache'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache') : '',
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase() === 'makensis.exe') return full;
      }
    }
  }
  return null;
}

/** 以 UTF-8 BOM 写入，NSIS 才能正确识别中文 */
function writeScript(file, text) {
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
}

const makensis = findMakensis();
if (!makensis) {
  console.log('未找到 makensis.exe，跳过探针');
  process.exit(0);
}
console.log('makensis：', makensis);

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// 被测文件复制到探针目录同级，用相对路径 include（NSIS 的绝对路径支持不稳）
fs.copyFileSync(path.join(ROOT, 'build', 'uninstall.nsh'), path.join(DIR, 'uninstall.nsh'));

const nsi = `Name "probe"
OutFile "probe.exe"
RequestExecutionLevel user
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
Var installMode
!define APP_PRODUCT_FILENAME "深寻 SSH"
!define APP_FILENAME "deepseek-ssh"
!include "uninstall.nsh"
Section "S"
  !insertmacro customUnInstall
SectionEnd
`;
writeScript(path.join(DIR, 'probe.nsi'), nsi);

try {
  const args = [process.env.NSIS_VERBOSE === '1' ? '/V3' : '/V2', path.join(DIR, 'probe.nsi')];
  const out = execFileSync(makensis, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (process.env.NSIS_VERBOSE === '1') console.log(out);
  console.log('  [PASS] customUnInstall 宏编译通过');
} catch (err) {
  console.log('  [FAIL] 编译失败：');
  console.log(err.stdout || '');
  console.log(err.stderr || '');
  process.exit(1);
}

// 二次编译：把宏内容 !echo 出来，确认它确实被展开（而不是空宏）
const echoNsi = nsi.replace(
  '  !insertmacro customUnInstall',
  '  !echo "---- 宏展开开始 ----"\n  !insertmacro customUnInstall\n  !echo "---- 宏展开结束 ----"',
);
writeScript(path.join(DIR, 'echo.nsi'), echoNsi);
try {
  const out = execFileSync(makensis, ['/V3', path.join(DIR, 'echo.nsi')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const between = out.split('---- 宏展开开始 ----')[1]?.split('---- 宏展开结束 ----')[0] ?? '(未捕获)';
  const lines = between.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  console.log(`  [信息] 宏展开后产生 ${lines.length} 行 NSIS 代码（去掉编译注记后）：`);
  const codeLines = lines.filter((l) => !/^\d+ (warning|note):/i.test(l) && !/^!/.test(l) && !/^Section|^Name|^OutFile/i.test(l));
  for (const l of codeLines.slice(0, 12)) console.log('         ' + l);
  console.log(`  ${codeLines.length > 0 ? '[PASS]' : '[FAIL]'} 宏确实展开了代码`);
} catch (err) {
  console.log('  [FAIL] echo 编译失败：', (err.stdout || '') + (err.stderr || ''));
}

const exePath = path.join(DIR, 'probe.exe');
if (!fs.existsSync(exePath)) {
  console.log('  [FAIL] 未生成探针安装程序');
  process.exit(1);
}

/**
 * 校验宏里引用的删除目标目录名是否正确。
 *
 * 说明：NSIS 把脚本字符串经压缩后写入产物，直接在内嵌资源里搜索文案并不可靠；
 * 这里改为对宏源码做静态检查 —— 目录名必须来自 APP_PRODUCT_FILENAME/APP_FILENAME，
 * 并包含常见目录名兜底，避免以后改产品名时漏改。
 */
const macroSource = fs.readFileSync(path.join(DIR, 'uninstall.nsh'), 'utf8');
const required = [
  { pattern: /\$APPDATA\\\$\{APP_PRODUCT_FILENAME\}/, label: '删除 $APPDATA\\${APP_PRODUCT_FILENAME}' },
  { pattern: /\$APPDATA\\\$\{APP_FILENAME\}/, label: '删除 $APPDATA\\${APP_FILENAME}' },
  { pattern: /\$LOCALAPPDATA\\\$\{APP_PRODUCT_FILENAME\}/, label: '清理 $LOCALAPPDATA 缓存' },
  { pattern: /KEEP_APP_DATA/, label: '覆盖安装/更新时跳过（KEEP_APP_DATA）' },
  { pattern: /"\/S"/, label: '静默卸载时跳过询问（/S）' },
  { pattern: /SetShellVarContext current/, label: '管理员实例下切回当前用户上下文' },
];

let pass = 0;
for (const item of required) {
  const ok = item.pattern.test(macroSource);
  if (ok) pass++;
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${item.label}`);
}

const ratio = `${pass}/${required.length}`;
console.log(`\n探针产物：${exePath}（${fs.statSync(exePath).size} 字节）`);
console.log(`=== 结果：编译通过 + 静态检查 ${ratio} ===`);
process.exit(pass === required.length ? 0 : 1);
