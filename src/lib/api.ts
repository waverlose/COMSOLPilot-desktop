// 统一的 sidecar 客户端。
//
// 端口和访问令牌都由**运行时外壳**提供（Tauri 的 Rust 侧 / Electron 主进程每次启动
// 随机挑选并生成），其余都是普通的 fetch 打到本机的 Python sidecar。每个请求都要带
// X-COMSOLPILOT-TOKEN，否则 sidecar 会返回 401——这是防止浏览器里其他网页调用
// 本地接口的一道闸。
//
// 外壳差异全部收在 `./shell` 里，这里只负责拼请求。
import {
  getBackendPort,
  getBackendToken,
  pickDirectory as shellPickDirectory,
  revealDirectory as shellRevealDirectory,
} from "./shell";

// 让老调用方继续能从 api 里拿到外壳判断，不必到处改 import
export { isTauri, shellKind, hasNativeShell } from "./shell";

function baseUrl(): Promise<string> {
  return getBackendPort().then((port) => `http://127.0.0.1:${port}`);
}

function authToken(): Promise<string> {
  return getBackendToken();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const [base, token] = await Promise.all([baseUrl(), authToken()]);
  const headers = new Headers(init.headers);
  if (token) headers.set("X-COMSOLPILOT-TOKEN", token);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetchWithRetry(`${base}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(await describeError(response));
  }
  return (await response.json()) as T;
}

// sidecar 是异步拉起的，窗口出现时它可能还没开始监听。`fetch` 连不上会抛
// TypeError（HTTP 错误码不会走到这里），此时退避重试，而不是把错误甩给用户。
const CONNECT_RETRIES = 15;
const CONNECT_DELAY_MS = 400;

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < CONNECT_RETRIES; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_DELAY_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function describeError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: unknown };
    if (typeof data.detail === "string") return data.detail;
    if (data.detail !== undefined) return JSON.stringify(data.detail);
  } catch {
    // 响应体不是 JSON，退回状态码文案
  }
  return `${response.status} ${response.statusText}`;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 原生能力
// ---------------------------------------------------------------------------

export function pickDirectory(): Promise<string | null> {
  // 浏览器里调界面时没有原生选择器，shell 会返回 null 让调用方安静地什么都不做
  return shellPickDirectory();
}

export function revealDirectory(path: string): Promise<void> {
  return shellRevealDirectory(path);
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ComsolInfo {
  found: boolean;
  path?: string | null;
  version?: string | null;
  server_binary?: string | null;
  desktop_binary?: string | null;
  source?: string | null;
}

export interface DepsEnvironment {
  path: string;
  version: string;
  source: string;
  source_label: string;
  label: string;
  packages: Record<string, boolean>;
  usable: boolean;
  project_root: string | null;
}

export interface DepsStatus {
  core_root: string;
  core_present: boolean;
  venv_present: boolean;
  interpreter: string | null;
  interpreter_source: string | null;
  interpreter_version: string | null;
  packages: Record<string, boolean>;
  missing: string[];
  reusable: DepsEnvironment[];
  environments: DepsEnvironment[];
  ready: boolean;
}

export interface EnvironmentList {
  environments: DepsEnvironment[];
  reusable: DepsEnvironment[];
}

export interface McpClient {
  id: string;
  label: string;
  detected: boolean;
  registered: boolean;
  path?: string | null;
  detail?: string | null;
}

export interface ServerStatus {
  running: boolean;
  starting: boolean;
  port: number;
  configured_port: number;
  pid?: number | null;
  mode?: string | null;
  server_exe?: string | null;
  comsol_version?: string | null;
  started_at?: string | null;
  uptime_seconds?: number | null;
  error?: string | null;
  log_tail: string[];
}

export interface AppSettings {
  core_root: string;
  logs_dir: string;
  port: number;
  configured_port?: number | null;
  login_mode: string;
  comsol_version: string;
  comsol_server_exe: string;
  comsol_desktop_exe: string;
  table_label: string;
  cores: number;
  python_exe: string;
}

export interface AppState {
  core_root: string;
  comsol: ComsolInfo;
  deps: DepsStatus;
  server: ServerStatus;
  clients: McpClient[];
  settings: AppSettings;
}

export interface ComsolVersion {
  name: string;
  server: string;
  desktop: string;
}

export interface VersionsResponse {
  available: boolean;
  active: string;
  versions: ComsolVersion[];
}

export interface SyncResult {
  client: string;
  label?: string;
  action?: string;
  detail?: string;
  reason?: string;
}

export interface ClientsResponse {
  clients: McpClient[];
  results: SyncResult[];
}

export interface LogTail {
  file: string | null;
  lines: string[];
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

export function getState(): Promise<AppState> {
  return request<AppState>("/api/state");
}

export function detectComsol(): Promise<ComsolInfo> {
  return request<ComsolInfo>("/api/comsol/detect");
}

export function setComsolPath(path: string): Promise<ComsolInfo> {
  return post<ComsolInfo>("/api/comsol/path", { path });
}

export function listComsolVersions(): Promise<VersionsResponse> {
  return request<VersionsResponse>("/api/comsol/versions");
}

export function setComsolVersion(version: string): Promise<{ ok: boolean; version?: string }> {
  return post<{ ok: boolean; version?: string }>("/api/comsol/version", { version });
}

export function getDepsStatus(refresh = false): Promise<DepsStatus> {
  return request<DepsStatus>(`/api/deps/status?refresh=${refresh}`);
}

/**
 * 扫描本机可用的 Python 环境。
 * 新用户机器上往往已经有能直接用的环境（旧版 COMSOLPilot、conda 环境等），
 * 能复用就不该再下载一遍依赖。
 */
export function listEnvironments(refresh = false): Promise<EnvironmentList> {
  return request<EnvironmentList>(`/api/deps/environments?refresh=${refresh}`);
}

export function useEnvironment(path: string): Promise<{ ok: boolean; environment: DepsEnvironment }> {
  return post<{ ok: boolean; environment: DepsEnvironment }>("/api/deps/use", { path });
}

export function listClients(): Promise<McpClient[]> {
  return request<McpClient[]>("/api/clients");
}

export function registerClients(ids: string[]): Promise<ClientsResponse> {
  return post<ClientsResponse>("/api/clients/register", { clients: ids });
}

export function syncClients(): Promise<ClientsResponse> {
  return post<ClientsResponse>("/api/clients/sync");
}

export function getServerStatus(): Promise<ServerStatus> {
  return request<ServerStatus>("/api/server/status");
}

export function startServer(mode: "headless" | "gui" = "headless"): Promise<ServerStatus> {
  return post<ServerStatus>("/api/server/start", { mode });
}

export function stopServer(): Promise<ServerStatus> {
  return post<ServerStatus>("/api/server/stop");
}

export function restartServer(mode: "headless" | "gui" = "headless"): Promise<ServerStatus> {
  return post<ServerStatus>("/api/server/restart", { mode });
}

export function getSettings(): Promise<AppSettings> {
  return request<AppSettings>("/api/settings");
}

export function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return post<AppSettings>("/api/settings", patch);
}

export function tailLogs(lines = 200): Promise<LogTail> {
  return request<LogTail>(`/api/logs/tail?lines=${lines}`);
}

/**
 * 依赖安装是流式的（pip 的实时输出）。返回一个取消函数。
 * 默认**先复用**已有环境；`force` 为真才强制新建并安装。
 * 失败时以 `[error] ...` 行的形式出现在日志里，所以不需要单独的 onError。
 */
export function streamDependencyInstall(
  onLine: (line: string) => void,
  onDone: (ok: boolean) => void,
  options: { force?: boolean; interpreter?: string } = {},
): () => void {
  let cancelled = false;

  void (async () => {
    let succeeded = false;
    try {
      const [base, token] = await Promise.all([baseUrl(), authToken()]);
      const headers = new Headers({ "Content-Type": "application/json" });
      if (token) headers.set("X-COMSOLPILOT-TOKEN", token);

      const response = await fetchWithRetry(`${base}/api/deps/install`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          force: options.force ?? false,
          interpreter: options.interpreter ?? "",
        }),
      });
      if (!response.ok) {
        onLine(`[error] ${await describeError(response)}`);
        onDone(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onDone(false);
        return;
      }

      const decoder = new TextDecoder();
      while (!cancelled) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n")) {
          if (!line) continue;
          if (line.startsWith("[done]")) succeeded = true;
          onLine(line);
        }
      }
    } catch (error) {
      onLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
      succeeded = false;
    }
    onDone(succeeded);
  })();

  return () => {
    cancelled = true;
  };
}
