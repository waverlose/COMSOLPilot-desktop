import { useEffect, useMemo, useState } from "react";
import { Check, Clipboard, ClipboardCheck, FileText, FolderOpen, Loader2 } from "lucide-react";
import { getClientConfig, listClients, registerClients, revealDirectory, testClient, type ClientConfigProfile, type McpClient, type ClientTestResult } from "../lib/api";
import { useAppState } from "../lib/appState";

interface Props {
  mode: "wizard" | "page";
  onNext?: () => void;
  onBack?: () => void;
  refreshKey?: number;
}

type Entry = {
  command?: string | string[];
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  environment?: Record<string, string>;
};

const SUPPORTED_CLIENTS: McpClient[] = [
  ["workbuddy", "WorkBuddy"], ["claude-code", "Claude Code"],
  ["claude-desktop", "Claude Desktop"], ["gemini", "Gemini CLI"],
  ["cursor", "Cursor"], ["windsurf", "Windsurf"], ["opencode", "OpenCode"],
  ["codex", "Codex"], ["deepseek", "DeepSeek"],
].map(([id, label]) => ({ id, label, detected: false, registered: false }));

export function ClientSetupPanel({ mode, onNext, onBack, refreshKey = 0 }: Props) {
  const isWizard = mode === "wizard";
  const { state } = useAppState();
  const [clients, setClients] = useState<McpClient[]>(SUPPORTED_CLIENTS);
  const [selectedId, setSelectedId] = useState("workbuddy");
  const [profile, setProfile] = useState<ClientConfigProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ClientTestResult | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void listClients().then((items) => {
      if (!alive) return;
      const detected = new Map(items.map((item) => [item.id, item]));
      setClients(SUPPORTED_CLIENTS.map((item) => detected.get(item.id) ?? item));
      setSelectedId((current) => current || items.find((item) => item.detected)?.id || "workbuddy");
      setError(null);
    }).catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [refreshKey]);

  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    setProfileLoading(true);
    void getClientConfig(selectedId).then((next) => {
      if (alive) {
        setProfile(next);
        setError(null);
      }
    }).catch((err: unknown) => {
      if (alive) {
        setProfile(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    }).finally(() => {
      if (alive) setProfileLoading(false);
    });
    return () => { alive = false; };
  }, [selectedId]);

  const configText = useMemo(() => profile ? formatConfig(profile) : "", [profile]);
  const groupedTools = useMemo(() => testResult?.ok ? testResult.groups : [], [testResult]);

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => current === label ? null : current), 1800);
    } catch {
      setError("无法访问剪贴板，请选中内容后手动复制。");
    }
  }

  async function revealConfigFolder() {
    if (!profile) return;
    const separator = profile.path.includes("\\") ? "\\" : "/";
    const folder = profile.path.slice(0, profile.path.lastIndexOf(separator));
    try {
      await revealDirectory(folder);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function writeConfig() {
    if (!profile) return;
    setWriting(true);
    setError(null);
    try {
      await registerClients([profile.id]);
      const items = await listClients();
      setClients(items);
      setCopied("written");
      window.setTimeout(() => setCopied((current) => current === "written" ? null : current), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWriting(false);
    }
  }

  async function runTest() {
    if (!profile) return;
    setTesting(true);
    setTestResult(null);
    try { setTestResult(await testClient(profile.id)); }
    catch (err) { setTestResult({ ok: false, client: profile.id, tools: [], groups: [], tool_count: 0, error: err instanceof Error ? err.message : String(err) }); }
    finally { setTesting(false); }
  }

  const aiPrompt = profile
    ? `请帮我把 COMSOLPilot MCP 接入 ${profile.label}。请先备份目标配置文件，再将以下配置合并进去；只新增或更新 comsolpilot 这一项，保留其他配置。不要改变其中的 Python、核心目录、环境变量和端口。\n\n配置文件：\n${profile.path}\n\n配置片段：\n${configText}\n\n完成后告诉我如何重启/启用该连接器。`
    : "";
  void aiPrompt;

  return (
    <div className={isWizard ? "step-body client-setup-wizard" : "client-setup-page"}>
      {isWizard ? (
        <>
          <h2 className="step-title-sm">准备客户端配置</h2>
        </>
      ) : (
        <div className="page-header client-setup-heading">
          <div><h1 className="page-title">客户端连接</h1></div>
          <button className="btn btn-ghost" onClick={() => void listClients().then(setClients)}><Clipboard size={15} />重新扫描</button>
        </div>
      )}

      {error && <div className="banner banner-error">{error}</div>}
      {(
        <div className="client-setup-layout">
          <aside className="client-setup-picker" aria-label="选择 AI 客户端">
            <div className="client-setup-picker-title">{loading ? "正在识别客户端…" : "选择客户端"}</div>
            {clients.map((client) => (
              <button key={client.id} className={`client-choice ${selectedId === client.id ? "is-selected" : ""}`} onClick={() => setSelectedId(client.id)} aria-pressed={selectedId === client.id}>
                <span className="client-choice-mark">{selectedId === client.id && <Check size={13} />}</span>
                <span className="client-choice-label">{client.label}</span>
                <span className={`client-choice-state ${client.detected ? "is-found" : ""}`}>{client.detected ? "已发现" : "未检测"}</span>
              </button>
            ))}
          </aside>

          <section className="client-profile">
            {profileLoading || !profile ? (
              <div className="status-card"><Loader2 size={16} className="spin" /><span>正在生成连接配置…</span></div>
            ) : (
              <>
                <div className="client-profile-head">
                  <div><h3>{profile.label}</h3><p>{clients.find((client) => client.id === profile.id)?.detected ? "检测到本机客户端配置" : "尚未检测到配置文件，可先复制配置备用"}</p></div>
                  <span className="client-format">{profile.kind === "codex_toml" ? "TOML" : "JSON"}</span>
                </div>

                <div className="client-path-block">
                  <div className="client-block-heading"><span><FolderOpen size={14} />配置文件路径</span><button className="btn btn-ghost btn-sm" onClick={() => void copy("path", profile.path)}>{copied === "path" ? <ClipboardCheck size={14} /> : <Clipboard size={14} />}{copied === "path" ? "已复制" : "复制路径"}</button></div>
                  <code>{profile.path}</code>
                </div>

                <div className="connection-facts">
                  <div><span>COMSOL 安装</span><code>{state?.comsol.path || "尚未检测"}</code></div>
                  <div><span>Python 环境</span><code>{profile.python_exe}</code></div>
                  <div><span>COMSOLPilot 核心</span><code>{profile.core_root}</code></div>
                  <div><span>Server 端口</span><code>{profile.port}</code></div>
                </div>

                <div className="client-block-heading config-heading"><span><FileText size={14} />连接配置</span><button className="btn btn-ghost btn-sm" onClick={() => void copy("config", configText)}>{copied === "config" ? <ClipboardCheck size={14} /> : <Clipboard size={14} />}{copied === "config" ? "已复制" : "复制配置"}</button></div>
                <pre className="config-preview"><code>{configText}</code></pre>

                <div className="client-setup-actions">
                  <button className="btn btn-primary" onClick={() => void writeConfig()} disabled={writing}>{writing ? <Loader2 className="spin" size={15} /> : <FileText size={15} />}{copied === "written" ? "已写入配置" : "直接写入配置"}</button>
                  <button className="btn btn-secondary" onClick={() => void copy("config", configText)}><Clipboard size={15} />复制配置</button>
                  <button className="btn btn-ghost" onClick={() => void runTest()} disabled={testing}>{testing ? <Loader2 className="spin" size={15} /> : <Check size={15} />}{testing ? "测试中" : "测试连接"}</button>
                  {clients.find((client) => client.id === profile.id)?.detected && <button className="btn btn-ghost" onClick={() => void revealConfigFolder()}><FolderOpen size={15} />打开配置目录</button>}
                </div>
                {testResult && <div className={`client-test-result ${testResult.ok ? "is-ok" : "is-fail"}`}><strong>{testResult.ok ? `连接成功 · ${testResult.tool_count} 个工具` : "连接失败"}</strong>{testResult.ok ? <div className="client-tool-groups">{groupedTools.map((group) => <section className="client-tool-group" key={group.id}><div className="client-tool-group-title"><span>{group.label}</span><small>{group.count}</small></div><div className="client-tool-list">{group.tools.map((tool) => <code key={tool}>{tool}</code>)}</div></section>)}</div> : <p>{testResult.error}</p>}</div>}
                <p className="client-setup-note">配置添加后，重启或重新载入该 AI 客户端并新建对话。使用工具前，请先在主页启动 COMSOL Server。</p>
              </>
            )}
          </section>
        </div>
      )}

      {isWizard && <div className="step-actions"><button className="btn btn-text" onClick={onBack}>上一步</button><div className="step-actions-left"><button className="btn btn-text" onClick={onNext}>稍后配置</button><button className="btn btn-primary" onClick={onNext}>进入主页</button></div></div>}
    </div>
  );
}

function formatConfig(profile: ClientConfigProfile): string {
  const entry = profile.entry as Entry;
  if (profile.kind === "codex_toml") {
    const command = tomlString(typeof entry.command === "string" ? entry.command : "");
    const args = (entry.args ?? []).map(tomlString).join(", ");
    const env = Object.entries(entry.env ?? {}).map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ");
    return `[mcp_servers.comsolpilot]\ncommand = ${command}\nargs = [${args}]\ncwd = ${tomlString(entry.cwd ?? "")}\nenv = { ${env} }`;
  }
  const section = profile.kind === "opencode" ? "mcp" : "mcpServers";
  return JSON.stringify({ [section]: { comsolpilot: entry } }, null, 2);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
