// 把 electron/*.ts 编译成 CommonJS，输出到 dist-electron/。
//
// 为什么要单独一步、而不是让 vite 一起处理：
//   1. 主进程跑在 Node 里，不经过浏览器打包，得有自己的 tsconfig；
//   2. 根 package.json 是 "type": "module"，Node 会把 .js 当 ESM 解析，而 Electron
//      主进程用 CJS 最稳（ESM 主进程与沙箱预加载都有额外约束）。所以在输出目录里放一个
//      标记文件，把这一层重新声明成 commonjs。
//
// 用法：node scripts/compile-electron.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist-electron");
const tsc = resolve(root, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) {
  console.error("[electron] 找不到 typescript，请先 npm install");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

execFileSync(process.execPath, [tsc, "-p", resolve(root, "electron", "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
});

// 让 Node 把 dist-electron 下的 .js 当 CommonJS 而不是继承根上的 "type": "module"
writeFileSync(
  resolve(outDir, "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
  "utf-8",
);

console.log("[electron] 主进程与预加载脚本已编译到 dist-electron/");
