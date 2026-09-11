/**
 * 查看 PE 文件（.exe）里嵌入的图标资源，判断图标是否真的写进了 exe。
 * 用法：node test/pe-icon-report.js <exe路径> [...更多exe]
 */
const fs = require('node:fs');
const path = require('node:path');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

function parsePeResources(file) {
  const buf = fs.readFileSync(file);
  const out = { file: path.basename(file), iconSizes: [], group: [], other: [] };
  if (buf.readUInt16LE(0) !== 0x5a4d) return { ...out, error: '不是 PE 文件' };

  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOffset) !== 0x00004550) return { ...out, error: 'PE 签名不正确' };

  const coff = peOffset + 4;
  const numberOfSections = buf.readUInt16LE(coff + 2);
  const optionalHeaderSize = buf.readUInt16LE(coff + 16);
  const optHeader = coff + 20;
  const isPe32Plus = buf.readUInt16LE(optHeader) === 0x20b;
  const dataDir = optHeader + (isPe32Plus ? 112 : 96);
  const resourceRva = buf.readUInt32LE(dataDir + 2 * 8);

  const sections = [];
  const sectionTable = optHeader + optionalHeaderSize;
  for (let i = 0; i < numberOfSections; i++) {
    const off = sectionTable + i * 40;
    sections.push({
      name: buf.toString('ascii', off, off + 8).replace(/\0+$/, ''),
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

  if (!resourceRva) return { ...out, error: '没有资源目录' };
  const resBase = rvaToOffset(resourceRva);
  if (resBase < 0) return { ...out, error: '资源目录不在任何段内' };

  /** 读取一个资源目录的所有条目 */
  const entries = (dirOffset) => {
    const list = [];
    const named = buf.readUInt16LE(dirOffset + 12);
    const idCount = buf.readUInt16LE(dirOffset + 14);
    for (let i = 0; i < named + idCount; i++) {
      const e = dirOffset + 16 + i * 8;
      list.push({
        // 高位为 1 表示命名条目（字符串偏移），否则是整数 ID
        name: buf.readUInt32LE(e),
        isString: (buf.readUInt32LE(e) & 0x80000000) !== 0,
        offset: buf.readUInt32LE(e + 4),
        isDir: (buf.readUInt32LE(e + 4) & 0x80000000) !== 0,
      });
    }
    return list;
  };

  const idOf = (entry) => entry.name & 0x7fffffff;

  for (const typeEntry of entries(resBase)) {
    if (!typeEntry.isDir) continue;
    const typeDir = resBase + (typeEntry.offset & 0x7fffffff);
    const size = entries(typeDir).length;
    const typeId = typeEntry.isString ? -1 : idOf(typeEntry);
    if (typeId === RT_ICON) {
      out.iconCount = size;
      const sizes = [];
      for (const nameEntry of entries(typeDir)) {
        if (!nameEntry.isDir) continue;
        const nameDir = resBase + (nameEntry.offset & 0x7fffffff);
        for (const langEntry of entries(nameDir)) {
          if (langEntry.isDir) continue;
          const dataEntry = resBase + langEntry.offset;
          const dataSize = buf.readUInt32LE(dataEntry + 4);
          sizes.push({ id: idOf(nameEntry), bytes: dataSize });
        }
      }
      out.iconSizes = sizes;
    } else if (typeId === RT_GROUP_ICON) {
      const groups = [];
      for (const nameEntry of entries(typeDir)) {
        if (!nameEntry.isDir) continue;
        const nameDir = resBase + (nameEntry.offset & 0x7fffffff);
        for (const langEntry of entries(nameDir)) {
          if (langEntry.isDir) continue;
          const dataEntry = resBase + langEntry.offset;
          const dataRva = buf.readUInt32LE(dataEntry);
          const dataSize = buf.readUInt32LE(dataEntry + 4);
          const dataOffset = rvaToOffset(dataRva);
          groups.push({ id: idOf(nameEntry), bytes: dataSize, head: buf.toString('hex', dataOffset, dataOffset + 8) });
        }
      }
      out.group = groups;
    } else {
      out.other.push(typeId);
    }
  }
  return out;
}

for (const f of process.argv.slice(2)) {
  console.log(`\n=== ${path.basename(f)} ===`);
  if (!fs.existsSync(f)) {
    console.log('  文件不存在');
    continue;
  }
  const info = parsePeResources(f);
  if (info.error) {
    console.log('  解析失败：', info.error);
    continue;
  }
  console.log('  图标图像数量(RT_ICON)：', info.iconCount ?? 0);
  console.log('  各图标字节数：', JSON.stringify(info.iconSizes));
  console.log('  图标组(RT_GROUP_ICON)：', JSON.stringify(info.group));
}
