#!/usr/bin/env node
// Sync the build version from the git tag (vX.Y.Z) into the app's version
// fields. Run from the repository root.
//
// Updates:
//   * package.json              -> "version"
//   * src-tauri/tauri.conf.json -> "version"  (controls the installer/bundle version)
//   * src-tauri/Cargo.toml      -> [package].version
//
// When no tag is present (e.g. manual build without a tag), the script is a
// no-op so local/dev builds are unaffected.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = process.env.GITHUB_REF_NAME ?? "";
const version = tag.replace(/^v/, "");

// A valid semver is required for installers. Bail silently otherwise.
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.log(`No semver tag detected (got "${tag}"), skipping version sync.`);
  process.exit(0);
}

const writeJson = (file, key) => {
  const path = resolve(file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  json[key] = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`  ${file}: ${key} -> ${version}`);
};

const cargoPath = resolve("src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8").replace(
  /^version\s*=\s*"[^"]*"/m,
  `version = "${version}"`,
);
writeFileSync(cargoPath, cargo);
console.log(`  src-tauri/Cargo.toml: version -> ${version}`);

writeJson("package.json", "version");
writeJson("src-tauri/tauri.conf.json", "version");
console.log(`Version synced to ${version} from tag ${tag}.`);
