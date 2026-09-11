/**
 * electron-builder 的 afterPack 钩子：把应用图标写入 exe 资源。
 *
 * 为什么需要它：
 *   electron-builder 自带的资源改写（signAndEditExecutable）会下载 winCodeSign 并
 *   解压出 macOS 符号链接，在「非管理员且未开启开发者模式」的 Windows 上会失败。
 *   运行时窗口图标已由主进程显式设置，但 exe 自身的内嵌图标（任务栏、资源管理器、
 *   快捷方式）需要写进 PE 资源，这里用 rcedit 直接完成这一步。
 *
 * 用法（由 electron-builder 自动调用）：
 *   win:
 *     signAndEditExecutable: false
 *   afterPack: scripts/after-pack.js
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 依序查找 rcedit-x64.exe */
function findRcedit(projectDir) {
  const candidates = [];

  const caches = [
    process.env.ELECTRON_BUILDER_CACHE,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'electron-builder', 'Cache') : '',
    path.join(projectDir, '.electron-builder-cache'),
  ].filter(Boolean);

  for (const cache of caches) {
    // 构建脚本自带的副本优先（版本可控）
    candidates.push(path.join(cache, 'rcedit-x64.exe'));
    const winCodeSign = path.join(cache, 'winCodeSign');
    if (fs.existsSync(winCodeSign)) {
      for (const dir of fs.readdirSync(winCodeSign)) {
        candidates.push(path.join(winCodeSign, dir, 'rcedit-x64.exe'));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

exports.default = async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  const exePath = path.join(appOutDir, `${productFilename}.exe`);
  const iconPath = path.join(projectDir, 'build', 'icon.ico');

  console.log(`  • 写入应用图标  exe=${path.basename(exePath)}`);

  if (!fs.existsSync(exePath)) {
    console.warn(`  • 跳过图标写入：找不到 ${exePath}`);
    return;
  }
  if (!fs.existsSync(iconPath)) {
    console.warn(`  • 跳过图标写入：找不到 ${iconPath}`);
    return;
  }

  const rcedit = findRcedit(projectDir);
  if (!rcedit) {
    console.warn('  • 跳过图标写入：未找到 rcedit-x64.exe（exe 将沿用 Electron 默认图标）');
    return;
  }

  try {
    execFileSync(
      rcedit,
      [
        exePath,
        '--set-icon',
        iconPath,
        // 顺便补上版本信息，资源管理器属性页会更好看
        '--set-file-version',
        context.packager.appInfo.version,
        '--set-product-version',
        context.packager.appInfo.version,
        '--set-version-string',
        'ProductName',
        context.packager.appInfo.productName,
        '--set-version-string',
        'FileDescription',
        context.packager.appInfo.productName,
        '--set-version-string',
        'CompanyName',
        'DeepSeek SSH',
      ],
      { stdio: 'inherit' },
    );
    console.log('  • 应用图标与版本信息写入完成');
  } catch (err) {
    console.warn(`  • 图标写入失败（不影响运行）：${err.message}`);
  }
};
