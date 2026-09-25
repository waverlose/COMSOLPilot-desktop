// 启动 Electron 的小包装。
//
// 为什么不能直接写 `electron .`：
//   有些环境（容器、CI、或带 Node 工具链的开发壳）会设 `ELECTRON_RUN_AS_NODE=1`。
//   这个变量一旦存在，electron.exe 会退化成纯 Node 运行时——进程能起来、退出码正常，
//   但**窗口永远不出现**，排查起来非常费劲。
//
//   注意必须把变量**整个删掉**，设成空串没用：Electron 在 C++ 层用 getenv 判断，
//   空串依然算「已设置」。
//
// 用法：node scripts/start-electron.mjs [额外参数]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// package.json 的 main 指向 dist-electron/main.js，那是 tsc 编出来的，不在版本库里。
// 少了它 Electron 会弹一句英文的 "Unable to find Electron app" 然后退出——
// 看不出是「忘了编译」。这里提前拦住，把原因和命令说清楚。
const entry = join(root, "dist-electron", "main.js");
if (!existsSync(entry)) {
  process.stderr.write(
    [
      "",
      "[electron] 找不到主进程入口：dist-electron/main.js",
      "[electron] 这个文件是编译产物，需要先生成。执行：",
      "",
      "             npm run electron:compile",
      "",
      "[electron] 或者直接用 npm run electron:start（它会自动先编译）。",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [root, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill());
}
