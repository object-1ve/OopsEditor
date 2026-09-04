#!/usr/bin/env node
/**
 * gen-latest-json.mjs — 为 tauri-plugin-updater 拼装 latest.json。
 *
 * 用法:
 *   node .github/scripts/gen-latest-json.mjs <tag> [搜索目录] [输出文件]
 *      <tag>      版本标签,如 v0.1.53(版本号取去掉 v 前缀的部分)
 *      搜索目录   缺省为当前目录;递归扫描其中的签名包
 *      输出文件   缺省为 <搜索目录>/latest.json
 *
 * 逻辑:递归找出所有 `<archive>.sig`,要求同名的 `<archive>` 存在,
 * 按文件名推断平台,signature 读 .sig 全文,url 指向本 tag 的 Release 附件:
 *   https://github.com/object-1ve/OopsEditor/releases/download/<tag>/<文件名>
 *
 * 平台映射:
 *   *.msi / *.msi.zip / *x64*.zip  -> windows-x86_64
 *   *.app.tar.gz / *.dmg           -> darwin-aarch64
 *
 * 找不到任何签名包时 exit 1(禁止静默发残包)。
 */
import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const OWNER = "object-1ve";
const REPO = "OopsEditor";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function platformOf(archiveName) {
  const n = archiveName.toLowerCase();
  if (n.endsWith(".msi") || n.endsWith(".msi.zip") || (n.endsWith(".zip") && n.includes("x64"))) {
    return "windows-x86_64";
  }
  if (n.endsWith(".app.tar.gz") || n.endsWith(".dmg")) {
    return "darwin-aarch64";
  }
  return null;
}

function main() {
  const [rawTag, searchDir = ".", outFile] = process.argv.slice(2);
  if (!rawTag) {
    console.error("用法: node .github/scripts/gen-latest-json.mjs <tag> [搜索目录] [输出文件]");
    process.exit(2);
  }
  const version = rawTag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`非法版本号: "${rawTag}"`);
    process.exit(1);
  }

  const sigFiles = walk(searchDir).filter((f) => f.endsWith(".sig"));
  const platforms = {};
  for (const sigPath of sigFiles) {
    const archivePath = sigPath.replace(/\.sig$/, "");
    if (!existsSync(archivePath)) {
      console.warn(`跳过 ${sigPath}:找不到对应的安装包 ${basename(archivePath)}`);
      continue;
    }
    const name = basename(archivePath);
    if (name === "latest.json") continue;
    const platform = platformOf(name);
    if (!platform) {
      console.warn(`跳过 ${name}:无法推断更新平台`);
      continue;
    }
    if (platforms[platform]) {
      console.warn(`跳过 ${name}:${platform} 已有 ${basename(platforms[platform].__file)}`);
      continue;
    }
    const signature = readFileSync(sigPath, "utf8").trim();
    if (!signature) {
      console.error(`签名为空: ${sigPath}`);
      process.exit(1);
    }
    platforms[platform] = {
      signature,
      url: `https://github.com/${OWNER}/${REPO}/releases/download/${rawTag}/${name}`,
      __file: archivePath,
    };
  }

  for (const [p, entry] of Object.entries(platforms)) {
    delete entry.__file;
    console.log(`  ${p}: ${entry.url}`);
  }

  if (Object.keys(platforms).length === 0) {
    console.error("未找到任何带签名的更新包(*.sig),拒绝生成 latest.json。");
    process.exit(1);
  }

  const latest = {
    version,
    pub_date: new Date().toISOString(),
    platforms,
  };
  const target = outFile ?? join(searchDir, "latest.json");
  writeFileSync(target, JSON.stringify(latest, null, 2) + "\n");
  console.log(`已写入 ${target}`);
}

main();
