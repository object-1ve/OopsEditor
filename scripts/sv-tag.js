import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let tag = "";
try {
  tag = execSync("git describe --tags --abbrev=0", {
    encoding: "utf8",
    cwd: rootDir,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  console.warn("[sv-tag] 无 git 或无 tag，保留原版本号（不中断构建）。");
  process.exit(0);
}

if (!tag) {
  console.warn("[sv-tag] 未找到 tag，保留原版本号（不中断构建）。");
  process.exit(0);
}

const ret = spawnSync(process.execPath, [path.join(rootDir, "scripts", "sv.js"), tag], {
  cwd: rootDir,
  stdio: "inherit",
});
process.exit(ret.status ?? 0);
