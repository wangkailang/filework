/**
 * Settings panel for MCP (Model Context Protocol) servers.
 *
 * Mirrors the visual style of `LlmConfigPanel` / `CredentialsPanel`:
 * card list of servers with a status dot, transport badge, tool count,
 * inline trusted / enabled toggles, and a "Reconnect" action. New
 * servers are added via an inline form (transport-conditional fields)
 * or by pasting Claude Desktop / Cursor JSON into the import dialog.
 *
 * Live state comes from `window.filework.mcp.onStatusChanged()` —
 * the main-process manager pushes one event per server-status change,
 * so the dots stay fresh without polling.
 */

import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  Cog,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface McpServerStatus {
  id: string;
  connected: boolean;
  connecting: boolean;
  toolCount: number;
  lastError: string | null;
  lastConnectedAt: string | null;
}

interface McpServerRow {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
  status: McpServerStatus;
}

interface FormState {
  id?: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  envText: string;
  cwd: string;
  url: string;
  headersText: string;
  trusted: boolean;
}

const emptyForm = (): FormState => ({
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  envText: "",
  cwd: "",
  url: "",
  headersText: "",
  trusted: false,
});

const formFromRow = (row: McpServerRow): FormState => ({
  id: row.id,
  name: row.name,
  transport: row.transport,
  command: row.command ?? "",
  args: row.args.join(" "),
  envText: Object.entries(row.env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n"),
  cwd: row.cwd ?? "",
  url: row.url ?? "",
  headersText: Object.entries(row.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n"),
  trusted: row.trusted,
});

const parseEnvLines = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
};

const parseHeaderLines = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
};

const parseArgs = (text: string): string[] => {
  // Whitespace split with simple quote support — enough for the typical
  // `npx -y @scope/server --flag value` shape MCP servers use.
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
};

const formToPayload = (form: FormState) => ({
  name: form.name.trim(),
  transport: form.transport,
  command: form.transport === "stdio" ? form.command.trim() || null : null,
  args: form.transport === "stdio" ? parseArgs(form.args) : [],
  env: form.transport === "stdio" ? parseEnvLines(form.envText) : {},
  cwd: form.transport === "stdio" ? form.cwd.trim() || null : null,
  url: form.transport === "http" ? form.url.trim() || null : null,
  headers: form.transport === "http" ? parseHeaderLines(form.headersText) : {},
  trusted: form.trusted,
});

export const McpConfigPanel = () => {
  const [rows, setRows] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{
    added: number;
    errors: string[];
  } | null>(null);
  const [expandedTools, setExpandedTools] = useState<string | null>(null);
  const [toolsCache, setToolsCache] = useState<
    Record<string, Array<{ name: string; description: string }>>
  >({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await window.filework.mcp.listServers()) as McpServerRow[];
      setRows(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const offStatus = window.filework.mcp.onStatusChanged(
      ({ id, status }: { id: string; status: unknown }) => {
        const s = status as McpServerStatus;
        setRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, status: s } : r)),
        );
      },
    );
    const offList = window.filework.mcp.onListChanged(() => {
      void refresh();
    });
    return () => {
      offStatus();
      offList();
    };
  }, [refresh]);

  const handleSave = async (form: FormState) => {
    const payload = formToPayload(form);
    if (!payload.name) {
      alert("Name is required");
      return;
    }
    if (payload.transport === "stdio" && !payload.command) {
      alert("Command is required for stdio servers");
      return;
    }
    if (payload.transport === "http" && !payload.url) {
      alert("URL is required for HTTP servers");
      return;
    }
    if (form.id) {
      await window.filework.mcp.updateServer(form.id, payload);
    } else {
      await window.filework.mcp.addServer(payload);
    }
    setEditing(null);
    void refresh();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete MCP server "${name}"?`)) return;
    await window.filework.mcp.deleteServer(id);
    void refresh();
  };

  const handleImport = async () => {
    setImportBusy(true);
    setImportResult(null);
    try {
      const res = (await window.filework.mcp.importJson(importText)) as {
        added: number;
        errors: string[];
      };
      setImportResult(res);
      if (res.added > 0) {
        setImportText("");
        void refresh();
      }
    } finally {
      setImportBusy(false);
    }
  };

  const loadTools = useCallback(async (id: string) => {
    const tools = (await window.filework.mcp.listTools(id)) as Array<{
      name: string;
      description: string;
    }>;
    setToolsCache((prev) => ({ ...prev, [id]: tools }));
  }, []);

  const toggleExpand = (id: string) => {
    if (expandedTools === id) {
      setExpandedTools(null);
    } else {
      setExpandedTools(id);
      if (!toolsCache[id]) void loadTools(id);
    }
  };

  return (
    <div className="space-y-4">
      <Header
        onAdd={() => setEditing(emptyForm())}
        onImport={() => {
          setImportOpen(true);
          setImportResult(null);
        }}
      />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <ServerCard
              key={row.id}
              row={row}
              expanded={expandedTools === row.id}
              tools={toolsCache[row.id]}
              onToggleTools={() => toggleExpand(row.id)}
              onEdit={() => setEditing(formFromRow(row))}
              onDelete={() => handleDelete(row.id, row.name)}
              onReconnect={() => window.filework.mcp.reconnect(row.id)}
              onSetEnabled={(v) =>
                window.filework.mcp.setEnabled(row.id, v).then(() => refresh())
              }
              onSetTrusted={(v) =>
                window.filework.mcp.setTrusted(row.id, v).then(() => refresh())
              }
            />
          ))}
        </div>
      )}

      {editing && (
        <EditModal
          form={editing}
          onChange={setEditing}
          onSave={() => handleSave(editing)}
          onClose={() => setEditing(null)}
        />
      )}

      {importOpen && (
        <ImportModal
          text={importText}
          onChange={setImportText}
          busy={importBusy}
          result={importResult}
          onImport={handleImport}
          onClose={() => {
            setImportOpen(false);
            setImportResult(null);
          }}
        />
      )}
    </div>
  );
};

const Header = ({
  onAdd,
  onImport,
}: {
  onAdd: () => void;
  onImport: () => void;
}) => (
  <div className="flex items-center justify-between">
    <div>
      <h3 className="text-sm font-medium text-foreground">MCP Servers</h3>
      <p className="text-xs text-muted-foreground">
        Connect tools from MCP-compatible servers (filesystem, github, …).
      </p>
    </div>
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onImport}
        className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Clipboard size={12} /> Import JSON
      </button>
      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-1 text-xs text-primary hover:opacity-80"
      >
        <Plus size={14} /> Add Server
      </button>
    </div>
  </div>
);

const EmptyState = () => (
  <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
    <Cog size={20} className="mx-auto mb-2 opacity-50" />
    No MCP servers configured. Add one or import a JSON config from Claude
    Desktop / Cursor.
  </div>
);

const StatusDot = ({ status }: { status: McpServerStatus }) => {
  if (status.connecting) {
    return <Loader2 size={12} className="animate-spin text-muted-foreground" />;
  }
  if (status.connected) {
    return <CheckCircle2 size={12} className="text-emerald-500" />;
  }
  if (status.lastError) {
    return <AlertCircle size={12} className="text-destructive" />;
  }
  return <span className="size-2 rounded-full bg-muted-foreground/40" />;
};

const ServerCard = ({
  row,
  expanded,
  tools,
  onToggleTools,
  onEdit,
  onDelete,
  onReconnect,
  onSetEnabled,
  onSetTrusted,
}: {
  row: McpServerRow;
  expanded: boolean;
  tools: Array<{ name: string; description: string }> | undefined;
  onToggleTools: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReconnect: () => void;
  onSetEnabled: (v: boolean) => void;
  onSetTrusted: (v: boolean) => void;
}) => {
  const tooltip = useMemo(() => {
    if (row.status.connected)
      return `Connected · ${row.status.toolCount} tools`;
    if (row.status.connecting) return "Connecting…";
    if (row.status.lastError) return `Error: ${row.status.lastError}`;
    return "Disconnected";
  }, [row.status]);

  return (
    <div className="rounded-lg border border-border bg-muted/40">
      <div className="flex items-center gap-3 px-3 py-2">
        <span title={tooltip} className="flex w-3 items-center justify-center">
          <StatusDot status={row.status} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {row.name}
            </span>
            <span className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {row.transport}
            </span>
            {row.status.connected && (
              <button
                type="button"
                onClick={onToggleTools}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                {row.status.toolCount} tools
              </button>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {row.transport === "stdio"
              ? `${row.command ?? "(no command)"}${row.args.length ? ` ${row.args.join(" ")}` : ""}`
              : (row.url ?? "(no url)")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Toggle
            checked={row.trusted}
            label="Trusted"
            onChange={onSetTrusted}
          />
          <Toggle
            checked={row.enabled}
            label="Enabled"
            onChange={onSetEnabled}
          />
          <IconBtn title="Reconnect" onClick={onReconnect}>
            <RefreshCw size={13} />
          </IconBtn>
          <IconBtn title="Edit" onClick={onEdit}>
            <Pencil size={13} />
          </IconBtn>
          <IconBtn title="Delete" danger onClick={onDelete}>
            <Trash2 size={13} />
          </IconBtn>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-3 py-2">
          {!tools ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : tools.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No tools exposed by this server.
            </div>
          ) : (
            <ul className="space-y-1">
              {tools.map((t) => (
                <li key={t.name} className="text-xs">
                  <span className="font-mono text-foreground">{t.name}</span>
                  {t.description && (
                    <span className="ml-2 text-muted-foreground">
                      {t.description}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {row.status.lastError && !row.status.connected && (
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-destructive">
          {row.status.lastError}
        </div>
      )}
    </div>
  );
};

const Toggle = ({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) => (
  <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="size-3 accent-primary"
    />
    {label}
  </label>
);

const IconBtn = ({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className={`rounded p-1 text-muted-foreground hover:bg-accent ${
      danger ? "hover:text-destructive" : "hover:text-foreground"
    }`}
  >
    {children}
  </button>
);

const EditModal = ({
  form,
  onChange,
  onSave,
  onClose,
}: {
  form: FormState;
  onChange: (f: FormState) => void;
  onSave: () => void;
  onClose: () => void;
}) => (
  <div className="fixed inset-0 z-110 flex items-center justify-center">
    <button
      type="button"
      className="absolute inset-0 bg-black/50 cursor-default"
      onClick={onClose}
      aria-label="Close"
    />
    <div className="relative w-[480px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-background p-5 shadow-2xl">
      <h3 className="mb-3 text-sm font-medium text-foreground">
        {form.id ? "Edit MCP Server" : "Add MCP Server"}
      </h3>
      <div className="space-y-3">
        <Field label="Name">
          <input
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            className="mcp-input"
            placeholder="filesystem"
          />
        </Field>
        <Field label="Transport">
          <div className="flex gap-2">
            {(["stdio", "http"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onChange({ ...form, transport: t })}
                className={`flex-1 rounded-md border px-3 py-1.5 text-xs ${
                  form.transport === t
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>

        {form.transport === "stdio" ? (
          <>
            <Field label="Command">
              <input
                value={form.command}
                onChange={(e) => onChange({ ...form, command: e.target.value })}
                className="mcp-input"
                placeholder="npx"
              />
            </Field>
            <Field label="Args">
              <input
                value={form.args}
                onChange={(e) => onChange({ ...form, args: e.target.value })}
                className="mcp-input"
                placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              />
            </Field>
            <Field label="Env (KEY=VAL per line, supports ${env:VAR})">
              <textarea
                value={form.envText}
                onChange={(e) => onChange({ ...form, envText: e.target.value })}
                className="mcp-input min-h-[64px] font-mono text-[11px]"
                placeholder="API_KEY=${env:OPENAI_API_KEY}"
              />
            </Field>
            <Field label="cwd (optional)">
              <input
                value={form.cwd}
                onChange={(e) => onChange({ ...form, cwd: e.target.value })}
                className="mcp-input"
                placeholder="/path/to/dir"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <input
                value={form.url}
                onChange={(e) => onChange({ ...form, url: e.target.value })}
                className="mcp-input"
                placeholder="https://example.com/mcp"
              />
            </Field>
            <Field label="Headers (Name: value per line)">
              <textarea
                value={form.headersText}
                onChange={(e) =>
                  onChange({ ...form, headersText: e.target.value })
                }
                className="mcp-input min-h-[64px] font-mono text-[11px]"
                placeholder="Authorization: Bearer ${env:MY_TOKEN}"
              />
            </Field>
          </>
        )}

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={form.trusted}
            onChange={(e) => onChange({ ...form, trusted: e.target.checked })}
            className="size-3 accent-primary"
          />
          Trusted (skip per-call approval)
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Save
        </button>
      </div>
      <style>{`
        .mcp-input {
          width: 100%;
          padding: 6px 8px;
          font-size: 12px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--background);
          color: var(--foreground);
        }
        .mcp-input:focus { outline: 1px solid var(--primary); }
      `}</style>
    </div>
  </div>
);

const ImportModal = ({
  text,
  onChange,
  busy,
  result,
  onImport,
  onClose,
}: {
  text: string;
  onChange: (v: string) => void;
  busy: boolean;
  result: { added: number; errors: string[] } | null;
  onImport: () => void;
  onClose: () => void;
}) => (
  <div className="fixed inset-0 z-110 flex items-center justify-center">
    <button
      type="button"
      className="absolute inset-0 bg-black/50 cursor-default"
      onClick={onClose}
      aria-label="Close"
    />
    <div className="relative w-[560px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-background p-5 shadow-2xl">
      <h3 className="mb-2 text-sm font-medium text-foreground">
        Import MCP servers from JSON
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Paste a Claude Desktop / Cursor / VS Code config —{" "}
        <code className="text-foreground">{`{ "mcpServers": { ... } }`}</code> —
        or a bare object keyed by server name.
      </p>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        className="w-full rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        placeholder='{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }'
      />
      {result && (
        <div className="mt-2 space-y-1 text-xs">
          <div className="text-emerald-500">
            Added {result.added} server{result.added === 1 ? "" : "s"}
          </div>
          {result.errors.map((e) => (
            <div key={e} className="text-destructive">
              {e}
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onImport}
          disabled={busy || !text.trim()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
    </div>
  </div>
);

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="space-y-1">
    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
    {children}
  </div>
);
