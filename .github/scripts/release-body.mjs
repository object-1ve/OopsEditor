#!/usr/bin/env node
/**
 * release-body.mjs — 从 git 提交历史自动生成 GitHub Release 正文。
 *
 * 用法:
 *   node .github/scripts/release-body.mjs <tag> [输出文件]
 *      <tag>    版本标签,如 v0.1.41(也可省略 v 前缀)
 *      输出文件  可选;缺省输出到 stdout
 *
 * 说明:正文完全由 commit 信息自动生成,无需手动维护 CHANGELOG。
 *   范围:上一个版本标签(不含)到当前标签(含)之间的所有非 merge 提交。
 *   若仓库里没有更早的标签,则列出当前标签能到达的全部提交。
 *
 * 依赖 git 完整历史:CI 中 release job 的 checkout 必须带 fetch-depth: 0
 * 与 fetch-tags: true,否则拿不到提交历史与前置标签。
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** 执行命令并返回 stdout,失败返回 null(不抛异常) */
function tryExec(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** 找到当前标签前一个可到达的版本标签(用于计算提交范围) */
function previousTag(tag) {
  // tag~1 取当前标签的父提交,再 describe 出最近的 tag
  const out = tryExec(`git describe --tags --abbrev=0 ${tag}~1`);
  return out ? out.trim() : null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    console.error("用法: node .github/scripts/release-body.mjs <tag> [输出文件]");
    process.exit(2);
  }
  const rawTag = args[0];
  const outFile = args[1];
  const tag = rawTag.replace(/^v/, ""); // 版本号展示用,去掉 v 前缀
  const version = tag;

  // 计算提交范围:上一个标签(不含)..当前标签(含)
  const prev = previousTag(rawTag);
  const range = prev ? `${prev}..${rawTag}` : rawTag;

  const log = tryExec(
    `git log --no-merges --format=%h%x09%s --no-decorate ${range}`,
  );

  if (log === null) {
    console.error(`无法从 git 获取提交记录(范围: ${range})。`);
    console.error(`请确认已用完整历史(fetch-depth: 0)检出,且标签 ${rawTag} 已存在。`);
    process.exit(1);
  }

  const lines = log.trim().split("\n").filter(Boolean);

  const body = [
    `## ${version}`,
    ``,
    lines.length > 0 ? `本次发布共 ${lines.length} 次提交:` : `(该版本无新的提交)`,
    ``,
    ...lines.map((l) => `- ${l}`),
    ``,
  ].join("\n");

  if (outFile) {
    writeFileSync(outFile, body);
    console.log(`已写入 ${outFile}`);
  } else {
    process.stdout.write(body);
  }
}

main();
