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
  KeyRound,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

interface McpServerStatus {
  id: string;
  connected: boolean;
  connecting: boolean;
  toolCount: number;
  lastError: string | null;
  lastConnectedAt: string | null;
  authStatus:
    | "not_applicable"
    | "unknown"
    | "needs_auth"
    | "authorizing"
    | "authenticated"
    | "expired"
    | "error";
  authMessage: string | null;
  authErrorCode:
    | "authorization_failed"
    | "callback_error"
    | "callback_listener_failed"
    | "callback_timeout"
    | "connection_failed"
    | "state_mismatch"
    | "token_exchange_failed"
    | null;
  authUrl: string | null;
}

type McpAuthType = "auto" | "none" | "oauth";

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
  authType: McpAuthType;
  oauthScopes: string[];
  oauthClientId: string | null;
  oauthClientSecretConfigured: boolean;
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
  authType: McpAuthType;
  oauthScopes: string;
  oauthClientId: string;
  oauthClientSecret: string;
  trusted: boolean;
}

interface OAuthSettingsForm {
  credentialsStore: "auto" | "database" | "keychain";
  callbackHost: string;
  callbackPort: string;
  callbackPath: string;
}

interface McpServerPayload {
  [key: string]: unknown;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  url: string | null;
  headers: Record<string, string>;
  authType: McpAuthType;
  oauthScopes: string[];
  oauthClientId: string | null;
  oauthClientSecret?: string | null;
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
  authType: "auto",
  oauthScopes: "",
  oauthClientId: "",
  oauthClientSecret: "",
  trusted: false,
});

const defaultOAuthSettings = (): OAuthSettingsForm => ({
  credentialsStore: "auto",
  callbackHost: "127.0.0.1",
  callbackPort: "0",
  callbackPath: "/callback",
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
  authType: row.authType ?? (row.transport === "http" ? "auto" : "none"),
  oauthScopes: row.oauthScopes.join(" "),
  oauthClientId: row.oauthClientId ?? "",
  oauthClientSecret: "",
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

const formToPayload = (form: FormState) => {
  const payload: McpServerPayload = {
    name: form.name.trim(),
    transport: form.transport,
    command: form.transport === "stdio" ? form.command.trim() || null : null,
    args: form.transport === "stdio" ? parseArgs(form.args) : [],
    env: form.transport === "stdio" ? parseEnvLines(form.envText) : {},
    cwd: form.transport === "stdio" ? form.cwd.trim() || null : null,
    url: form.transport === "http" ? form.url.trim() || null : null,
    headers:
      form.transport === "http" ? parseHeaderLines(form.headersText) : {},
    authType: form.transport === "http" ? form.authType : "none",
    oauthScopes:
      form.transport === "http" && form.authType !== "none"
        ? parseArgs(form.oauthScopes)
        : [],
    oauthClientId:
      form.transport === "http" && form.authType !== "none"
        ? form.oauthClientId.trim() || null
        : null,
    trusted: form.trusted,
  };
  if (form.transport === "http" && form.authType !== "none") {
    const secret = form.oauthClientSecret.trim();
    if (secret) payload.oauthClientSecret = secret;
  } else {
    payload.oauthClientSecret = null;
  }
  return payload;
};

export const shouldShowClearAuthorization = (row: {
  authType: McpAuthType;
  status: Pick<McpServerStatus, "authStatus">;
}) => row.authType !== "none" && row.status.authStatus === "authenticated";

export const McpConfigPanel = () => {
  const { LL } = useI18nContext();
  const [rows, setRows] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [editingError, setEditingError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{
    added: number;
    errors: string[];
  } | null>(null);
  const [oauthSettingsOpen, setOAuthSettingsOpen] = useState(false);
  const [expandedTools, setExpandedTools] = useState<string | null>(null);
  const [toolsCache, setToolsCache] = useState<
    Record<string, Array<{ name: string; description: string }>>
  >({});
  const [pendingConfirm, setPendingConfirm] = useState<{
    kind: "delete" | "clearAuthorization";
    id: string;
    message: string;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

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
      setEditingError(LL.mcpConfig_nameRequired());
      return;
    }
    if (payload.transport === "stdio" && !payload.command) {
      setEditingError(LL.mcpConfig_commandRequired());
      return;
    }
    if (payload.transport === "http" && !payload.url) {
      setEditingError(LL.mcpConfig_urlRequired());
      return;
    }
    if (form.id) {
      await window.filework.mcp.updateServer(form.id, payload);
    } else {
      await window.filework.mcp.addServer(payload);
    }
    setEditing(null);
    setEditingError(null);
    void refresh();
  };

  const handleDelete = (id: string, name: string) => {
    setPendingConfirm({
      kind: "delete",
      id,
      message: LL.mcpConfig_deleteConfirm({ name }),
    });
  };

  const handleClearAuthorization = (id: string, name: string) => {
    setPendingConfirm({
      kind: "clearAuthorization",
      id,
      message: LL.mcpConfig_clearAuthorizationConfirm({ name }),
    });
  };

  const handleConfirmAction = async () => {
    if (!pendingConfirm) return;
    setConfirmBusy(true);
    try {
      if (pendingConfirm.kind === "delete") {
        await window.filework.mcp.deleteServer(pendingConfirm.id);
      } else {
        await window.filework.mcp.clearAuthorization(pendingConfirm.id);
      }
      setPendingConfirm(null);
      void refresh();
    } finally {
      setConfirmBusy(false);
    }
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
        onAdd={() => {
          setEditing(emptyForm());
          setEditingError(null);
        }}
        onImport={() => {
          setImportOpen(true);
          setImportResult(null);
        }}
        onOAuthSettings={() => setOAuthSettingsOpen(true)}
      />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />{" "}
          {LL.mcpConfig_loading()}
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
              onEdit={() => {
                setEditing(formFromRow(row));
                setEditingError(null);
              }}
              onDelete={() => handleDelete(row.id, row.name)}
              onReconnect={() => window.filework.mcp.reconnect(row.id)}
              onAuthorize={() =>
                window.filework.mcp.authorize(row.id).then(() => refresh())
              }
              onClearAuthorization={() =>
                handleClearAuthorization(row.id, row.name)
              }
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
          error={editingError}
          onChange={(next) => {
            setEditing(next);
            setEditingError(null);
          }}
          onSave={() => handleSave(editing)}
          onClose={() => {
            setEditing(null);
            setEditingError(null);
          }}
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

      {oauthSettingsOpen && (
        <OAuthSettingsModal onClose={() => setOAuthSettingsOpen(false)} />
      )}

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.message ?? ""}
        confirmLabel={
          pendingConfirm?.kind === "delete"
            ? LL.mcpConfig_delete()
            : LL.mcpConfig_clearAuthorization()
        }
        cancelLabel={LL.mcpConfig_cancel()}
        destructive={pendingConfirm?.kind === "delete"}
        busy={confirmBusy}
        onOpenChange={(open) => {
          if (!open) setPendingConfirm(null);
        }}
        onConfirm={handleConfirmAction}
      />
    </div>
  );
};

const Header = ({
  onAdd,
  onImport,
  onOAuthSettings,
}: {
  onAdd: () => void;
  onImport: () => void;
  onOAuthSettings: () => void;
}) => {
  const { LL } = useI18nContext();
  return (
    <div className="flex items-center justify-between">
      <div>
        <h3 className="text-sm font-medium text-foreground">
          {LL.mcpConfig_title()}
        </h3>
        <p className="text-xs text-muted-foreground">
          {LL.mcpConfig_description()}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOAuthSettings}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Cog size={12} /> {LL.mcpConfig_oauthSettings()}
        </button>
        <button
          type="button"
          onClick={onImport}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Clipboard size={12} /> {LL.mcpConfig_importJson()}
        </button>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1 text-xs text-primary hover:opacity-80"
        >
          <Plus size={14} /> {LL.mcpConfig_add()}
        </button>
      </div>
    </div>
  );
};

const EmptyState = () => {
  const { LL } = useI18nContext();
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
      <Cog size={20} className="mx-auto mb-2 opacity-50" />
      {LL.mcpConfig_empty()}
    </div>
  );
};

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
  onAuthorize,
  onClearAuthorization,
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
  onAuthorize: () => void;
  onClearAuthorization: () => void;
  onSetEnabled: (v: boolean) => void;
  onSetTrusted: (v: boolean) => void;
}) => {
  const { LL } = useI18nContext();
  const tooltip = useMemo(() => {
    if (row.status.authStatus === "needs_auth")
      return LL.mcpConfig_authStatusNeedsAuth();
    if (row.status.authStatus === "authorizing")
      return LL.mcpConfig_authStatusAuthorizing();
    if (row.status.connected)
      return LL.mcpConfig_statusConnected({ count: row.status.toolCount });
    if (row.status.connecting) return LL.mcpConfig_statusConnecting();
    if (row.status.lastError)
      return LL.mcpConfig_statusError({ message: row.status.lastError });
    return LL.mcpConfig_statusDisconnected();
  }, [LL, row.status]);
  const canAuthorize = row.authType !== "none" && !row.status.connected;
  const canClearAuthorization = shouldShowClearAuthorization(row);
  const visibleError =
    row.status.authMessage ?? row.status.lastError ?? undefined;

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
            {row.authType === "auto" && (
              <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                {LL.mcpConfig_authAuto()}
              </span>
            )}
            {row.authType === "oauth" && (
              <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                {LL.mcpConfig_authOAuth()}
              </span>
            )}
            {row.status.connected && (
              <button
                type="button"
                onClick={onToggleTools}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                {LL.mcpConfig_toolsCount({ count: row.status.toolCount })}
              </button>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {row.transport === "stdio"
              ? `${row.command ?? LL.mcpConfig_noCommand()}${row.args.length ? ` ${row.args.join(" ")}` : ""}`
              : (row.url ?? LL.mcpConfig_noUrl())}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Toggle
            checked={row.trusted}
            label={LL.mcpConfig_trusted()}
            onChange={onSetTrusted}
          />
          <Toggle
            checked={row.enabled}
            label={LL.mcpConfig_enabled()}
            onChange={onSetEnabled}
          />
          <IconBtn title={LL.mcpConfig_reconnect()} onClick={onReconnect}>
            <RefreshCw size={13} />
          </IconBtn>
          {canAuthorize && (
            <IconBtn title={LL.mcpConfig_authorize()} onClick={onAuthorize}>
              <KeyRound size={13} />
            </IconBtn>
          )}
          {canClearAuthorization && (
            <IconBtn
              title={LL.mcpConfig_clearAuthorization()}
              onClick={onClearAuthorization}
            >
              <LogOut size={13} />
            </IconBtn>
          )}
          <IconBtn title={LL.mcpConfig_edit()} onClick={onEdit}>
            <Pencil size={13} />
          </IconBtn>
          <IconBtn title={LL.mcpConfig_delete()} danger onClick={onDelete}>
            <Trash2 size={13} />
          </IconBtn>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-3 py-2">
          {!tools ? (
            <div className="text-xs text-muted-foreground">
              {LL.mcpConfig_loading()}
            </div>
          ) : tools.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              {LL.mcpConfig_noTools()}
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

      {visibleError && !row.status.connected && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-[11px] text-destructive">
          <span className="min-w-0 flex-1">
            <span>{visibleError}</span>
            {row.status.authErrorCode && (
              <span className="ml-2 whitespace-nowrap text-destructive/70">
                {LL.mcpConfig_authErrorCode({
                  code: row.status.authErrorCode,
                })}
              </span>
            )}
          </span>
          {canAuthorize && (
            <button
              type="button"
              onClick={onAuthorize}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/15"
            >
              <KeyRound size={12} />
              {LL.mcpConfig_authorize()}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const OAuthSettingsModal = ({ onClose }: { onClose: () => void }) => {
  const { LL } = useI18nContext();
  const [form, setForm] = useState<OAuthSettingsForm>(defaultOAuthSettings);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [credentialsStore, callbackHost, callbackPort, callbackPath] =
        await Promise.all([
          window.filework.getSetting("mcp.oauth.credentialsStore"),
          window.filework.getSetting("mcp.oauth.callbackHost"),
          window.filework.getSetting("mcp.oauth.callbackPort"),
          window.filework.getSetting("mcp.oauth.callbackPath"),
        ]);
      if (cancelled) return;
      setForm({
        credentialsStore:
          credentialsStore === "database" || credentialsStore === "keychain"
            ? credentialsStore
            : "auto",
        callbackHost: callbackHost || "127.0.0.1",
        callbackPort: callbackPort || "0",
        callbackPath: callbackPath || "/callback",
      });
      setBusy(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    await Promise.all([
      window.filework.setSetting(
        "mcp.oauth.credentialsStore",
        form.credentialsStore,
      ),
      window.filework.setSetting("mcp.oauth.callbackHost", form.callbackHost),
      window.filework.setSetting("mcp.oauth.callbackPort", form.callbackPort),
      window.filework.setSetting("mcp.oauth.callbackPath", form.callbackPath),
    ]);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="gap-0! bg-background! p-5! text-foreground! shadow-2xl w-[460px]! max-w-[calc(100vw-32px)]!">
        <DialogTitle className="mb-3 pr-8 text-sm font-medium text-foreground">
          {LL.mcpConfig_oauthSettingsTitle()}
        </DialogTitle>
        {busy ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            {LL.mcpConfig_loading()}
          </div>
        ) : (
          <div className="space-y-3">
            <Field label={LL.mcpConfig_oauthCredentialsStore()}>
              <select
                value={form.credentialsStore}
                onChange={(e) =>
                  setForm({
                    ...form,
                    credentialsStore: e.target
                      .value as OAuthSettingsForm["credentialsStore"],
                  })
                }
                className="mcp-input"
              >
                <option value="auto">{LL.mcpConfig_oauthStoreAuto()}</option>
                <option value="keychain">
                  {LL.mcpConfig_oauthStoreKeychain()}
                </option>
                <option value="database">
                  {LL.mcpConfig_oauthStoreDatabase()}
                </option>
              </select>
            </Field>
            <Field label={LL.mcpConfig_oauthCallbackHost()}>
              <input
                value={form.callbackHost}
                onChange={(e) =>
                  setForm({ ...form, callbackHost: e.target.value })
                }
                className="mcp-input"
                placeholder="127.0.0.1"
              />
            </Field>
            <Field label={LL.mcpConfig_oauthCallbackPort()}>
              <input
                value={form.callbackPort}
                onChange={(e) =>
                  setForm({ ...form, callbackPort: e.target.value })
                }
                className="mcp-input"
                inputMode="numeric"
                placeholder="0"
              />
            </Field>
            <Field label={LL.mcpConfig_oauthCallbackPath()}>
              <input
                value={form.callbackPath}
                onChange={(e) =>
                  setForm({ ...form, callbackPath: e.target.value })
                }
                className="mcp-input"
                placeholder="/callback"
              />
            </Field>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {LL.mcpConfig_cancel()}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {LL.mcpConfig_save()}
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
      </DialogContent>
    </Dialog>
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
  error,
  onChange,
  onSave,
  onClose,
}: {
  form: FormState;
  error: string | null;
  onChange: (f: FormState) => void;
  onSave: () => void;
  onClose: () => void;
}) => {
  const { LL } = useI18nContext();
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="gap-0! overflow-y-auto bg-background! p-5! text-foreground! shadow-2xl w-[480px]! max-w-[calc(100vw-32px)]! max-h-[calc(100vh-64px)]!">
        <DialogTitle className="mb-3 pr-8 text-sm font-medium text-foreground">
          {form.id ? LL.mcpConfig_editTitle() : LL.mcpConfig_addTitle()}
        </DialogTitle>
        {error && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div className="space-y-3">
          <Field label={LL.mcpConfig_name()}>
            <input
              value={form.name}
              onChange={(e) => onChange({ ...form, name: e.target.value })}
              className="mcp-input"
              placeholder="filesystem"
            />
          </Field>
          <Field label={LL.mcpConfig_transport()}>
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
              <Field label={LL.mcpConfig_command()}>
                <input
                  value={form.command}
                  onChange={(e) =>
                    onChange({ ...form, command: e.target.value })
                  }
                  className="mcp-input"
                  placeholder="npx"
                />
              </Field>
              <Field label={LL.mcpConfig_args()}>
                <input
                  value={form.args}
                  onChange={(e) => onChange({ ...form, args: e.target.value })}
                  className="mcp-input"
                  placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                />
              </Field>
              <Field label={LL.mcpConfig_env()}>
                <textarea
                  value={form.envText}
                  onChange={(e) =>
                    onChange({ ...form, envText: e.target.value })
                  }
                  className="mcp-input min-h-[64px] font-mono text-[11px]"
                  placeholder="API_KEY=${env:OPENAI_API_KEY}"
                />
              </Field>
              <Field label={LL.mcpConfig_cwd()}>
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
              <Field label={LL.mcpConfig_url()}>
                <input
                  value={form.url}
                  onChange={(e) => onChange({ ...form, url: e.target.value })}
                  className="mcp-input"
                  placeholder="https://example.com/mcp"
                />
              </Field>
              <Field label={LL.mcpConfig_auth()}>
                <div className="flex gap-2">
                  {(["auto", "none", "oauth"] as const).map((authType) => (
                    <button
                      key={authType}
                      type="button"
                      onClick={() => onChange({ ...form, authType })}
                      className={`flex-1 rounded-md border px-3 py-1.5 text-xs ${
                        form.authType === authType
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      {authType === "auto"
                        ? LL.mcpConfig_authAuto()
                        : authType === "oauth"
                          ? LL.mcpConfig_authOAuth()
                          : LL.mcpConfig_authNone()}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={LL.mcpConfig_headers()}>
                <textarea
                  value={form.headersText}
                  onChange={(e) =>
                    onChange({ ...form, headersText: e.target.value })
                  }
                  className="mcp-input min-h-[64px] font-mono text-[11px]"
                  placeholder="Authorization: Bearer ${env:MY_TOKEN}"
                />
              </Field>
              {form.authType !== "none" && (
                <details className="rounded-md border border-border px-3 py-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    {LL.mcpConfig_oauthAdvanced()}
                  </summary>
                  <div className="mt-3 space-y-3">
                    <Field label={LL.mcpConfig_oauthScopes()}>
                      <input
                        value={form.oauthScopes}
                        onChange={(e) =>
                          onChange({ ...form, oauthScopes: e.target.value })
                        }
                        className="mcp-input"
                        placeholder="gmail.readonly"
                      />
                    </Field>
                    <Field label={LL.mcpConfig_oauthClientId()}>
                      <input
                        value={form.oauthClientId}
                        onChange={(e) =>
                          onChange({ ...form, oauthClientId: e.target.value })
                        }
                        className="mcp-input"
                        placeholder="client-id"
                      />
                    </Field>
                    <Field label={LL.mcpConfig_oauthClientSecret()}>
                      <input
                        value={form.oauthClientSecret}
                        onChange={(e) =>
                          onChange({
                            ...form,
                            oauthClientSecret: e.target.value,
                          })
                        }
                        className="mcp-input"
                        type="password"
                        placeholder={LL.mcpConfig_keepExistingSecret()}
                      />
                    </Field>
                  </div>
                </details>
              )}
            </>
          )}

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={form.trusted}
              onChange={(e) => onChange({ ...form, trusted: e.target.checked })}
              className="size-3 accent-primary"
            />
            {LL.mcpConfig_trustedHint()}
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {LL.mcpConfig_cancel()}
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            {LL.mcpConfig_save()}
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
      </DialogContent>
    </Dialog>
  );
};

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
}) => {
  const { LL } = useI18nContext();
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="gap-0! bg-background! p-5! text-foreground! shadow-2xl w-[560px]! max-w-[calc(100vw-32px)]!">
        <DialogTitle className="mb-2 pr-8 text-sm font-medium text-foreground">
          {LL.mcpConfig_importTitle()}
        </DialogTitle>
        <p className="mb-3 text-xs text-muted-foreground">
          {LL.mcpConfig_importDescription()}{" "}
          <code className="text-foreground">{`{ "mcpServers": { ... } }`}</code>
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
              {LL.mcpConfig_importAdded({ count: result.added })}
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
            {LL.mcpConfig_importClose()}
          </button>
          <button
            type="button"
            onClick={onImport}
            disabled={busy || !text.trim()}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? LL.mcpConfig_importing() : LL.mcpConfig_import()}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

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
