/**
 * 打包产物图标检查：
 *   1. exe 内嵌图标是否为我们的图标（逐字节比对 build/icon.ico）；
 *   2. exe 版本资源（afterPack 写入）是否为本应用；
 *   3. resources/icon.ico 是否随包分发；
 *   4. 以打包产物的目录布局启动 main，确认运行时能解析到该图标。
 *
 * 用法：node_modules/electron/dist/electron.exe test/packaged-icon-test.js
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const UNPACKED = path.join(ROOT, 'release', 'win-unpacked');
const STAGE = path.join(__dirname, '.userdata-icon-stage');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${extra ? '  -> ' + extra : ''}`);
}

/* --------------------------- 极简 PE 资源解析 --------------------------- */
function parsePe(buf) {
  const peOffset = buf.readUInt32LE(0x3c);
  const coff = peOffset + 4;
  const sections = [];
  const numberOfSections = buf.readUInt16LE(coff + 2);
  const optionalHeaderSize = buf.readUInt16LE(coff + 16);
  const optHeader = coff + 20;
  const isPe32Plus = buf.readUInt16LE(optHeader) === 0x20b;
  const dataDir = optHeader + (isPe32Plus ? 112 : 96);
  const resourceRva = buf.readUInt32LE(dataDir + 2 * 8);
  const sectionTable = optHeader + optionalHeaderSize;
  for (let i = 0; i < numberOfSections; i++) {
    const off = sectionTable + i * 40;
    sections.push({
      virtualSize: buf.readUInt32LE(off + 8),
      virtualAddress: buf.readUInt32LE(off + 12),
      rawSize: buf.readUInt32LE(off + 16),
      rawPointer: buf.readUInt32LE(off + 20),
    });
  }
  const rvaToOffset = (rva) => {
    for (const s of sections) {
      const size = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
        return s.rawPointer + (rva - s.virtualAddress);
      }
    }
    return -1;
  };
  const resBase = rvaToOffset(resourceRva);
  const entries = (dirOffset) => {
    const list = [];
    const named = buf.readUInt16LE(dirOffset + 12);
    const idCount = buf.readUInt16LE(dirOffset + 14);
    for (let i = 0; i < named + idCount; i++) {
      const e = dirOffset + 16 + i * 8;
      const name = buf.readUInt32LE(e);
      const offset = buf.readUInt32LE(e + 4);
      list.push({ id: name & 0x7fffffff, isString: (name & 0x80000000) !== 0, offset, isDir: (offset & 0x80000000) !== 0 });
    }
    return list;
  };
  const dataOf = (langEntry) => {
    const dataEntry = resBase + langEntry.offset;
    const rva = buf.readUInt32LE(dataEntry);
    const size = buf.readUInt32LE(dataEntry + 4);
    const off = rvaToOffset(rva);
    return { size, buf: buf.subarray(off, off + size) };
  };

  const out = { icons: [], groupBytes: 0, versionStrings: {} };
  for (const typeEntry of entries(resBase)) {
    if (!typeEntry.isDir) continue;
    const typeDir = resBase + (typeEntry.offset & 0x7fffffff);
    const typeId = typeEntry.isString ? -1 : typeEntry.id;

    if (typeId === RT_ICON) {
      for (const nameEntry of entries(typeDir)) {
        if (!nameEntry.isDir) continue;
        const nameDir = resBase + (nameEntry.offset & 0x7fffffff);
        for (const langEntry of entries(nameDir)) {
          if (langEntry.isDir) continue;
          out.icons.push(dataOf(langEntry).size);
        }
      }
    } else if (typeId === RT_GROUP_ICON) {
      for (const nameEntry of entries(typeDir)) {
        if (!nameEntry.isDir) continue;
        const nameDir = resBase + (nameEntry.offset & 0x7fffffff);
        for (const langEntry of entries(nameDir)) {
          if (langEntry.isDir) continue;
          out.groupBytes = dataOf(langEntry).size;
        }
      }
    } else if (typeId === RT_VERSION) {
      for (const nameEntry of entries(typeDir)) {
        if (!nameEntry.isDir) continue;
        const nameDir = resBase + (nameEntry.offset & 0x7fffffff);
        for (const langEntry of entries(nameDir)) {
          if (langEntry.isDir) continue;
          const raw = dataOf(langEntry).buf;
          // 版本资源里的字符串是 UTF-16LE，这里粗提取可读片段
          const text = raw.toString('utf16le');
          for (const key of ['ProductName', 'FileDescription', 'CompanyName', 'FileVersion', 'ProductVersion']) {
            const idx = text.indexOf(key);
            if (idx >= 0) {
              const value = text
                .slice(idx + key.length, idx + key.length + 80)
                .replace(/[\u0000-\u001f]+/g, ' ')
                .trim();
              out.versionStrings[key] = value.split('  ')[0].slice(0, 60);
            }
          }
        }
      }
    }
  }
  return out;
}

/** 统计 ico 文件里包含的图像字节数 */
function icoImageSizes(icoPath) {
  const buf = fs.readFileSync(icoPath);
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16;
    sizes.push(buf.readUInt32LE(base + 8));
  }
  return sizes;
}

app.setPath('userData', path.join(__dirname, '.userdata-icon-run'));
app.setName('deepseek-ssh');

app.whenReady().then(async () => {
  let code = 1;
  try {
    console.log('\n=== 打包产物图标检查 ===\n');

    const exePath = path.join(UNPACKED, '深寻SSH.exe');
    const icoPath = path.join(ROOT, 'build', 'icon.ico');
    const portablePath = path.join(ROOT, 'release', 'DeepSeekSSH-1.1.0-portable.exe');
    const setupPath = path.join(ROOT, 'release', 'DeepSeekSSH-1.1.0-setup.exe');

    check('主程序 exe 存在', fs.existsSync(exePath), exePath);
    const want = icoImageSizes(icoPath);
    console.log(`  [信息] build/icon.ico 含 ${want.length} 个图像，字节数 ${JSON.stringify(want)}`);

    for (const [label, file] of [
      ['主程序 exe', exePath],
      ['便携版 exe', portablePath],
      ['安装包 exe', setupPath],
    ]) {
      if (!fs.existsSync(file)) {
        check(`${label} 存在`, false, file);
        continue;
      }
      const info = parsePe(fs.readFileSync(file));
      const got = info.icons.slice().sort((a, b) => b - a);
      const expected = want.slice().sort((a, b) => b - a);
      const same = got.length === expected.length && got.every((v, i) => v === expected[i]);
      check(`${label} 内嵌图标与 build/icon.ico 完全一致`, same, `实际 ${got.length} 个：${JSON.stringify(got)}`);
    }

    const exeInfo = parsePe(fs.readFileSync(exePath));
    console.log('  [信息] exe 版本资源：', JSON.stringify(exeInfo.versionStrings));
    check(
      'exe 版本信息属于本应用',
      /深寻|DeepSeek/i.test(JSON.stringify(exeInfo.versionStrings)),
      JSON.stringify(exeInfo.versionStrings),
    );

    const resIcon = path.join(UNPACKED, 'resources', 'icon.ico');
    check('resources/icon.ico 随包分发（运行时窗口图标来源）', fs.existsSync(resIcon), resIcon);
    if (fs.existsSync(resIcon)) {
      const resSizes = icoImageSizes(resIcon).sort((a, b) => b - a);
      check(
        '随包图标与 build/icon.ico 一致',
        JSON.stringify(resSizes) === JSON.stringify(want.slice().sort((a, b) => b - a)),
        JSON.stringify(resSizes),
      );
    }

    /* ---- 4) 运行时图标解析：按打包产物的目录布局启动 main ---- */
    const asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));
    fs.rmSync(STAGE, { recursive: true, force: true });
    fs.mkdirSync(STAGE, { recursive: true });
    const asarPath = path.join(UNPACKED, 'resources', 'app.asar');
    asar.extractAll(asarPath, path.join(STAGE, 'app'));
    // 还原打包产物的真实布局：<resourcesPath>/app.asar 与 <resourcesPath>/icon.ico 同级
    fs.mkdirSync(path.join(STAGE, 'resources'), { recursive: true });
    if (fs.existsSync(resIcon)) fs.copyFileSync(resIcon, path.join(STAGE, 'resources', 'icon.ico'));
    // 让主进程里的 process.resourcesPath 指向这个伪装的 resources 目录
    Object.defineProperty(process, 'resourcesPath', {
      value: path.join(STAGE, 'resources'),
      configurable: true,
    });

    require(path.join(STAGE, 'app', 'dist', 'main', 'index.js'));
    const win = await new Promise((resolve) => {
      const timer = setInterval(() => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w) {
          clearInterval(timer);
          resolve(w);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(timer);
        resolve(null);
      }, 10000);
    });
    check('按打包布局启动后窗口已创建', !!win);
    if (win) {
      await new Promise((r) => win.webContents.once('did-finish-load', r));
      await new Promise((r) => setTimeout(r, 800));
      const resolved = await win.webContents.executeJavaScript(
        `window.__dshE2E && window.__dshE2E.iconPath ? window.__dshE2E.iconPath() : null`,
        true,
      );
      console.log('  [信息] 运行时解析到的图标路径：', resolved);
      check('运行时成功解析到图标资源（非空）', typeof resolved === 'string' && resolved.length > 0, String(resolved));
      check(
        '运行时图标取自随包 resources 目录（而非开发目录）',
        typeof resolved === 'string' && resolved.includes(path.join('resources', 'icon.ico')),
        String(resolved),
      );
    }

    const failed = results.filter((r) => !r.ok);    console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 项通过 ===`);
    for (const f of failed) console.log(`  未通过：${f.name} ${f.extra}`);
    code = failed.length === 0 ? 0 : 1;
  } catch (err) {
    console.error('检查脚本异常：', err);
  }
  setTimeout(() => app.exit(code), 300);
});
