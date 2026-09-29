#!/usr/bin/env node
/**
 * 版本单一来源。
 *
 * `package.json` 的 `version` 是唯一真源，其余清单由本脚本派生：
 *   * `src-tauri/tauri.conf.json` → `version`（决定安装包文件名与升级比对）
 *   * `src-tauri/Cargo.toml`      → `[package] version`（决定 exe 的文件属性）
 *   * `core/pyproject.toml` and `core/src/__init__.py` → core package version
 *   * `python-sidecar/sidecar_server.py` → HTTP API version
 *
 * `electron-builder.yml` 里的 `${version}` 直接读 package.json，不需要同步。
 *
 * 为什么必须有这个脚本：版本号一旦分叉，症状是「装了新版，更新检查却说已是最新」，
 * 或者 NSIS 生成的安装包名和 Release 里上传的对不上——两种都很难一眼看出原因。
 * CI 里跑 `--check` 可以在打包前就拦住。
 *
 * 用法：
 *   node scripts/sync-version.mjs           写入：把所有清单对齐到 package.json
 *   node scripts/sync-version.mjs --check   只校验：不一致则退出码 1（CI 用）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

const PKG = join(ROOT, "package.json");
const TAURI_CONF = join(ROOT, "src-tauri", "tauri.conf.json");
const CARGO_TOML = join(ROOT, "src-tauri", "Cargo.toml");
const CORE_PYPROJECT = join(ROOT, "core", "pyproject.toml");
const CORE_INIT = join(ROOT, "core", "src", "__init__.py");
const SIDECAR_SERVER = join(ROOT, "python-sidecar", "sidecar_server.py");

const version = JSON.parse(readFileSync(PKG, "utf-8")).version;
if (typeof version !== "string" || version.trim() === "") {
  console.error("[version] package.json 里没有可用的 version");
  process.exit(1);
}

/** 同步过程中记录的两类结果：实际改动的、以及 --check 下判定为过期的。 */
const changed = [];
const stale = [];

// ---------------------------------------------------------------------------
// src-tauri/tauri.conf.json
// ---------------------------------------------------------------------------
{
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf-8"));
  const current = typeof conf.version === "string" ? conf.version : "";
  if (current === version) {
    // 已经一致，什么都不做
  } else if (CHECK) {
    stale.push(`src-tauri/tauri.conf.json  version = ${current || "(缺失)"}`);
  } else {
    conf.version = version;
    writeFileSync(TAURI_CONF, `${JSON.stringify(conf, null, 2)}\n`, "utf-8");
    changed.push(`src-tauri/tauri.conf.json  ${current || "(缺失)"} → ${version}`);
  }
}

// ---------------------------------------------------------------------------
// src-tauri/Cargo.toml
//
// 只动 `[package]` 段里的 version。`[dependencies]` 里每个 crate 也都有 version，
// 用全局正则会一起改掉，所以先切出 [package] 段再在里面替换。
// ---------------------------------------------------------------------------
{
  const raw = readFileSync(CARGO_TOML, "utf-8");

  // 从 `[package]` 开始，直到下一个段头（或文件结束）
  const packageSection = raw.match(/^\[package\][^\n]*\n[\s\S]*?(?=^\[|\Z)/m);
  if (packageSection === null) {
    console.error("[version] src-tauri/Cargo.toml 里找不到 [package] 段");
    process.exit(1);
  }

  const block = packageSection[0];
  const versionLine = block.match(/^version\s*=\s*"([^"]*)"/m);
  if (versionLine === null) {
    console.error("[version] src-tauri/Cargo.toml 的 [package] 段里找不到 version");
    process.exit(1);
  }

  const current = versionLine[1];
  if (current === version) {
    // 已经一致
  } else if (CHECK) {
    stale.push(`src-tauri/Cargo.toml         version = ${current}`);
  } else {
    const patched = block.replace(
      /^version\s*=\s*"[^"]*"/m,
      `version = "${version}"`,
    );
    writeFileSync(CARGO_TOML, raw.replace(block, patched), "utf-8");
    changed.push(`src-tauri/Cargo.toml         ${current} → ${version}`);
  }
}

// ---------------------------------------------------------------------------
// Core and sidecar runtime versions
// ---------------------------------------------------------------------------
// The desktop diagnostics page reads the core package version, while API
// clients see the sidecar version. Keep both derived from package.json too.
function syncTextVersion(path, pattern, replacement, label) {
  const raw = readFileSync(path, "utf-8");
  const match = raw.match(pattern);
  if (match === null) {
    console.error(`[version] ${label} 里找不到版本号`);
    process.exit(1);
  }
  const current = match[1];
  if (current === version) return;
  if (CHECK) {
    stale.push(`${label}  version = ${current}`);
    return;
  }
  writeFileSync(path, raw.replace(pattern, replacement), "utf-8");
  changed.push(`${label}  ${current} → ${version}`);
}

syncTextVersion(
  CORE_PYPROJECT,
  /^version\s*=\s*"([^"]*)"/m,
  `version = "${version}"`,
  "core/pyproject.toml",
);
syncTextVersion(
  CORE_INIT,
  /^__version__\s*=\s*"([^"]*)"/m,
  `__version__ = "${version}"`,
  "core/src/__init__.py",
);
syncTextVersion(
  SIDECAR_SERVER,
  /version="([^"]*)"/,
  `version="${version}"`,
  "python-sidecar/sidecar_server.py",
);

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------
if (CHECK) {
  if (stale.length > 0) {
    console.error(`[version] 版本号与 package.json（${version}）不一致：`);
    for (const line of stale) console.error(`  ✗ ${line}`);
    console.error("[version] 执行 npm run version:sync 对齐后再打包。");
    process.exit(1);
  }
  console.log(`[version] 所有版本清单一致：${version}`);
  process.exit(0);
}

if (changed.length === 0) {
  console.log(`[version] 无需改动，三处清单都已是 ${version}`);
} else {
  console.log(`[version] 已同步到 ${version}：`);
  for (const line of changed) console.log(`  ✓ ${line}`);
}
