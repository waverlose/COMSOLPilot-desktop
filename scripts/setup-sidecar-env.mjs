// 给开发态的后端（sidecar）准备一个「装了 fastapi/uvicorn/pydantic」的 Python。
//
// 为什么需要这个脚本：
//   Electron/Tauri 主进程要用一个 Python 去跑 `python-sidecar/sidecar_server.py`。
//   机器上往往有好几个 python（PATH 里的、conda 的、别的项目遗留的 venv），
//   PATH 里第一个通常**没有** fastapi，于是后端起不来，界面上只看到「连不上后端」。
//   让用户自己去猜该用哪个解释器很不友好，所以这里做两件事：
//
//     1. **先找现成的**——任何已经装齐依赖的解释器直接复用，一个包都不装；
//     2. 实在没有，才在工程目录下建 `.venv-sidecar` 并装上依赖。
//
//   选定的解释器路径写进 `sidecar-python.json`，主进程启动时会读它。
//
// 用法：npm run sidecar:setup
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = join(ROOT, "sidecar-python.json");
const VENV_DIR = join(ROOT, ".venv-sidecar");
const REQUIREMENTS = join(ROOT, "python-sidecar", "requirements.txt");

const NEEDED = ["fastapi", "uvicorn", "pydantic"];
const IMPORT_PROBE = `import ${NEEDED.join(", ")}`;
const PYPI = "https://pypi.org/simple";

const log = (message) => process.stdout.write(`${message}\n`);

/** 能不能跑起来（不关心依赖）。 */
function runs(command) {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", shell: false, timeout: 20000 });
  return !probe.error && probe.status === 0;
}

/** 依赖是否齐全。只 import 不执行别的，不会拉起 COMSOL 的 JVM。 */
function hasDeps(command) {
  const probe = spawnSync(command, ["-c", IMPORT_PROBE], {
    stdio: "ignore",
    shell: false,
    timeout: 30000,
  });
  return !probe.error && probe.status === 0;
}

/** 收集候选解释器：环境变量 → 上次记录 → PATH 上的常见命令名。 */
function candidates() {
  const list = [];

  const explicit = process.env.COMSOLPILOT_PYTHON;
  if (explicit !== undefined && explicit.trim() !== "") list.push(explicit);

  try {
    if (existsSync(RECORD)) {
      const value = JSON.parse(readFileSync(RECORD, "utf-8")).python;
      if (typeof value === "string" && value.trim() !== "") list.push(value);
    }
  } catch {
    // 记录文件坏了就当没有，下面会重新挑并覆盖
  }

  for (const name of ["python", "py", "python3"]) {
    if (!list.includes(name)) list.push(name);
  }
  return list;
}

function record(python) {
  writeFileSync(RECORD, `${JSON.stringify({ python }, null, 2)}\n`, "utf-8");
  log(`\n已记录到 sidecar-python.json：${python}`);
  log("以后 npm run electron:start / tauri dev 都会用它启动后端。");
}

// --- 1. 复用现成环境 -------------------------------------------------------
log("正在查找已装齐依赖的 Python…");
const tried = new Set();

for (const command of candidates()) {
  if (tried.has(command)) continue;
  tried.add(command);

  if (!runs(command)) {
    log(`  ✗ ${command} —— 无法执行`);
    continue;
  }
  if (hasDeps(command)) {
    log(`  ✓ ${command} —— 依赖齐全，直接复用（不安装任何包）`);
    record(command);
    process.exit(0);
  }
  log(`  · ${command} —— 可执行，但缺 ${NEEDED.join("/")}`);
}

// --- 2. 都没有才建虚拟环境 -------------------------------------------------
log("\n没有找到现成的可用环境，改为在工程目录下新建 .venv-sidecar。");

const base = candidates().find((command) => runs(command));
if (base === undefined) {
  log("[错误] 这台机器上没有可用的 Python（需要 3.10 或更高）。");
  log("       请先安装 Python：https://www.python.org/downloads/");
  process.exit(1);
}

log(`使用基础解释器：${base}`);

if (!existsSync(VENV_DIR)) {
  const created = spawnSync(base, ["-m", "venv", VENV_DIR], { stdio: "inherit", shell: false });
  if (created.status !== 0) {
    log("[错误] 创建虚拟环境失败。");
    process.exit(1);
  }
} else {
  log("已存在 .venv-sidecar，跳过创建。");
}

const venvPython = join(VENV_DIR, "Scripts", "python.exe");
const python = existsSync(venvPython) ? venvPython : join(VENV_DIR, "bin", "python");

log("\n安装依赖（fastapi / uvicorn / pydantic / pyinstaller）…");
let installed = spawnSync(python, ["-m", "pip", "install", "-r", REQUIREMENTS], {
  stdio: "inherit",
  shell: false,
});

// 有些机器的 pip 默认源不通，退回官方源再试一次
if (installed.status !== 0) {
  log("\n默认源安装失败，改用官方 PyPI 重试…");
  installed = spawnSync(
    python,
    ["-m", "pip", "install", "-r", REQUIREMENTS, "--index-url", PYPI],
    { stdio: "inherit", shell: false },
  );
}

if (installed.status !== 0) {
  log("[错误] 依赖安装失败，请检查网络或代理设置。");
  process.exit(1);
}

record(python);
