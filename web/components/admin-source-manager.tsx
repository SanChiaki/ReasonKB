"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleSlash2,
  Database,
  FolderPlus,
  Folder,
  FileText,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { readAdminCsrfToken } from "@/components/admin-shell";

export type AdminSource = {
  id: string;
  kind: "local" | "smb" | "seeyon";
  displayName: string;
  state: string;
  scope: Record<string, unknown>;
  config: Record<string, unknown>;
  configRevision: number;
  selectionPolicy: "none" | "explicit" | "all";
  schedule: {
    mode: "scheduled" | "manual";
    intervalSeconds: number | null;
    maxDocumentSizeBytes: number;
  };
  health: {
    state: string;
    consecutiveFailureCount: number;
    lastSuccessAt: string | null;
    nextSyncAt: string | null;
    errorSummary: string | null;
  };
  validatedAt: string | null;
  purgeAfter: string | null;
  createdAt: string;
  updatedAt: string;
};

type SourceCollection = {
  id: string;
  displayName: string;
  externalId: string;
  rootExternalId: string | null;
  origin: string;
  validationState: string;
  lifecycleState: string;
  selected: boolean;
  validationError: string | null;
  projectId: string | null;
  exclusionRuleId: string | null;
};

type SourceExclusion = {
  id: string;
  collectionId: string;
  targetType: "collection" | "folder" | "document";
  targetExternalId: string;
  displayPath: string;
  createdAt: string;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (init?.method && init.method !== "GET") {
    headers.set("x-reasonkb-csrf", readAdminCsrfToken());
  }
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.assign("/admin/login");
    throw new Error("管理员会话已失效。");
  }
  if (!response.ok) {
    throw new Error(payload.error ?? `请求失败 (${response.status})`);
  }
  return payload as T;
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

const kindLabels = { local: "本地目录", smb: "SMB 共享", seeyon: "致远文档库" };
const validationPollIntervalMs = 1000;
const validationPollAttempts = 60;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function HealthMark({ source }: { source: AdminSource }) {
  if (source.health.state === "normal") {
    return <CheckCircle2 size={16} className="text-[var(--pi-success)]" aria-label="正常" />;
  }
  if (["degraded", "needs_attention"].includes(source.health.state)) {
    return <AlertTriangle size={16} className="text-[var(--pi-danger)]" aria-label="需处理" />;
  }
  return <CircleDashed size={16} className="text-[var(--pi-muted)]" aria-label="未知" />;
}

function ActionButton({
  label,
  onClick,
  icon: Icon,
  danger = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  icon: typeof Play;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white transition disabled:cursor-not-allowed disabled:opacity-35 ${
        danger
          ? "text-[var(--pi-danger)] hover:bg-red-50"
          : "text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
      }`}
    >
      <Icon size={15} aria-hidden="true" />
    </button>
  );
}

export function AdminSourceManager({ initialSources }: { initialSources: AdminSource[] }) {
  const [sources, setSources] = useState(initialSources);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh(): Promise<AdminSource[] | null> {
    setBusy(true);
    setError("");
    try {
      const payload = await api<{ sources: AdminSource[] }>("/api/admin/sources");
      setSources(payload.sources);
      return payload.sources;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加载数据源。");
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4 border-b border-[var(--pi-border)] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase text-[var(--pi-muted)]">Corpus administration</p>
          <h1 className="mt-1 text-2xl font-semibold">数据源</h1>
          <p className="mt-1 text-sm text-[var(--pi-muted)]">
            配置可同时运行的本地、SMB 与致远只读数据源。更改会由后台 worker 自动拾取。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--pi-border)] bg-white px-3 text-sm text-[var(--pi-muted)] hover:text-[var(--pi-ink)] disabled:opacity-50"
          >
            <RefreshCw size={15} className={busy ? "animate-spin" : ""} /> 刷新
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--pi-brand)] px-3 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus size={16} /> 新建数据源
          </button>
        </div>
      </div>

      {error ? <p className="mt-4 text-sm text-[var(--pi-danger)]">{error}</p> : null}

      <div className="mt-5 space-y-3">
        {sources.length === 0 ? (
          <div className="border border-dashed border-[var(--pi-border)] bg-white px-6 py-12 text-center">
            <Database className="mx-auto text-[var(--pi-muted)]" size={28} />
            <p className="mt-3 text-sm font-medium">尚未配置数据源</p>
            <p className="mt-1 text-xs text-[var(--pi-muted)]">新数据源默认不选择任何目录。</p>
          </div>
        ) : (
          sources.map((source) => (
            <SourceRow key={source.id} source={source} onChanged={refresh} />
          ))
        )}
      </div>

      {creating ? (
        <CreateSourcePanel
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      ) : null}
    </>
  );
}

function SourceRow({
  source,
  onChanged,
}: {
  source: AdminSource;
  onChanged: () => Promise<AdminSource[] | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [detailRevision, setDetailRevision] = useState(0);
  const refreshDetails = useCallback(() => {
    setDetailRevision((value) => value + 1);
  }, []);

  async function action(name: "validate" | "enable" | "disable" | "sync" | "restore") {
    setWorking(true);
    setError("");
    try {
      await api(`/api/admin/sources/${source.id}/actions`, {
        method: "POST",
        body: JSON.stringify({ action: name }),
      });
      let refreshed = await onChanged();
      if (name === "validate" || name === "enable") {
        for (let attempt = 0; attempt < validationPollAttempts; attempt += 1) {
          const current = refreshed?.find((item) => item.id === source.id);
          if (!current || current.health.state !== "unknown") break;
          await wait(validationPollIntervalMs);
          refreshed = await onChanged();
        }
      }
      refreshDetails();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setWorking(false);
    }
  }

  async function remove(immediate = false) {
    if (!immediate && !window.confirm(`将“${source.displayName}”移入待清除状态？`)) return;
    let confirmation: string | undefined;
    if (immediate) {
      confirmation = window.prompt(`输入数据源名称“${source.displayName}”确认立即清除`) ?? undefined;
      if (confirmation !== source.displayName) return;
    }
    setWorking(true);
    try {
      await api(`/api/admin/sources/${source.id}`, {
        method: "DELETE",
        body: JSON.stringify({ immediate, confirmation }),
      });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败。");
    } finally {
      setWorking(false);
    }
  }

  const scope =
    source.kind === "local"
      ? String(source.scope.rootPath ?? "")
      : source.kind === "smb"
        ? `//${String(source.scope.host ?? "")}/${String(source.scope.share ?? "")}/${String(source.scope.basePath ?? "")}`.replace(/\/$/, "")
        : String(source.scope.endpoint ?? "");

  return (
    <article className="border border-[var(--pi-border)] bg-white">
      <div className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--pi-bg)] text-[var(--pi-muted)]">
            <Server size={16} />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{source.displayName}</span>
              <span className="rounded border border-[var(--pi-border)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--pi-muted)]">
                {source.kind}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-[var(--pi-muted)]">{scope}</span>
          </span>
        </button>

        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-5 lg:w-[640px]">
          <span><span className="text-[var(--pi-muted)]">状态</span><br />{source.state}</span>
          <span><span className="text-[var(--pi-muted)]">健康</span><br /><span className="inline-flex items-center gap-1"><HealthMark source={source} />{source.health.state}</span></span>
          <span><span className="text-[var(--pi-muted)]">上次成功</span><br />{formatDate(source.health.lastSuccessAt)}</span>
          <span><span className="text-[var(--pi-muted)]">{["degraded", "needs_attention"].includes(source.health.state) ? "下次重试" : "下次同步"}</span><br />{formatDate(source.health.nextSyncAt)}</span>
          <span><span className="text-[var(--pi-muted)]">连续失败</span><br />{source.health.consecutiveFailureCount}</span>
        </div>

        <div className="flex items-center gap-1">
          <ActionButton label="编辑" icon={Pencil} onClick={() => setEditing((value) => !value)} disabled={working || source.state === "pending_purge"} />
          <ActionButton label="验证连接" icon={CheckCircle2} onClick={() => action("validate")} disabled={working || ["disabled", "pending_purge"].includes(source.state)} />
          <ActionButton label="立即同步" icon={Play} onClick={() => action("sync")} disabled={working || source.state !== "active"} />
          {source.state === "disabled" || source.state === "needs_attention" ? (
            <ActionButton label="启用并验证" icon={RotateCcw} onClick={() => action("enable")} disabled={working} />
          ) : source.state === "pending_purge" ? (
            <ActionButton label="恢复" icon={RotateCcw} onClick={() => action("restore")} disabled={working} />
          ) : (
            <ActionButton label="停用" icon={X} onClick={() => action("disable")} disabled={working} />
          )}
          <ActionButton label={source.state === "pending_purge" ? "立即清除" : "移入待清除"} icon={Trash2} onClick={() => remove(source.state === "pending_purge")} danger disabled={working} />
        </div>
      </div>

      {error || source.health.errorSummary ? (
        <p className="border-t border-[var(--pi-border)] bg-red-50 px-4 py-2 text-xs text-[var(--pi-danger)]">
          {error || source.health.errorSummary}
        </p>
      ) : null}

      {editing ? <SourceEditForm source={source} onSaved={async () => { setEditing(false); await onChanged(); }} /> : null}
      {expanded ? (
        <>
          <CollectionManager
            source={source}
            refreshRevision={detailRevision}
            onExclusionsChanged={refreshDetails}
          />
          <SourceRuntimeStatus
            source={source}
            externalRevision={detailRevision}
            onExclusionsChanged={refreshDetails}
          />
        </>
      ) : null}
    </article>
  );
}

function SourceEditForm({ source, onSaved }: { source: AdminSource; onSaved: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const credentials: Record<string, string> = {};
    for (const key of ["username", "password", "domain"] as const) {
      const value = String(data.get(key) ?? "").trim();
      if (value) credentials[key] = value;
    }
    const config = source.kind === "seeyon"
      ? { loginName: String(data.get("loginName") ?? "").trim() }
      : undefined;
    setSaving(true);
    setError("");
    try {
      await api(`/api/admin/sources/${source.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: String(data.get("displayName") ?? "").trim(),
          schedule: {
            mode: data.get("scheduleMode"),
            intervalSeconds: Number(data.get("intervalSeconds")),
            maxDocumentSizeBytes: Number(data.get("maxSizeMb")) * 1024 * 1024,
          },
          ...(config ? { config } : {}),
          ...(Object.keys(credentials).length ? { credentials } : {}),
        }),
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 border-t border-[var(--pi-border)] bg-[var(--pi-bg-soft)] px-4 py-4 md:grid-cols-3 lg:grid-cols-6">
      <Field label="显示名称"><input name="displayName" required defaultValue={source.displayName} /></Field>
      <Field label="同步方式"><select name="scheduleMode" defaultValue={source.schedule.mode}><option value="scheduled">定时</option><option value="manual">手工</option></select></Field>
      <Field label="间隔（秒）"><input name="intervalSeconds" type="number" min="5" required defaultValue={source.schedule.intervalSeconds ?? 300} /></Field>
      <Field label="单文件上限（MB）"><input name="maxSizeMb" type="number" min="1" max="1024" required defaultValue={Math.round(source.schedule.maxDocumentSizeBytes / 1024 / 1024)} /></Field>
      {source.kind === "seeyon" ? <Field label="loginName"><input name="loginName" required defaultValue={String(source.config.loginName ?? "")} /></Field> : null}
      {source.kind !== "local" ? <Field label="替换用户名"><input name="username" autoComplete="off" placeholder="留空不变" /></Field> : null}
      {source.kind === "smb" ? <Field label="替换域"><input name="domain" placeholder="留空不变" /></Field> : null}
      {source.kind !== "local" ? <Field label="替换密码"><input name="password" type="password" autoComplete="new-password" placeholder="留空不变" /></Field> : null}
      <div className="flex items-end"><button disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--pi-brand)] px-3 text-sm text-white disabled:opacity-50"><Save size={15} />{saving ? "保存中" : "保存"}</button></div>
      {error ? <p className="md:col-span-3 lg:col-span-6 text-xs text-[var(--pi-danger)]">{error}</p> : null}
    </form>
  );
}

function CollectionManager({
  source,
  refreshRevision,
  onExclusionsChanged,
}: {
  source: AdminSource;
  refreshRevision: number;
  onExclusionsChanged: () => void;
}) {
  const [collections, setCollections] = useState<SourceCollection[]>([]);
  const [policy, setPolicy] = useState(source.selectionPolicy);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    try {
      const payload = await api<{ selectionPolicy: AdminSource["selectionPolicy"]; collections: SourceCollection[] }>(`/api/admin/sources/${source.id}/collections`);
      setPolicy(payload.selectionPolicy);
      setCollections(payload.collections);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加载目录。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [source.id, source.updatedAt, refreshRevision]);

  async function updatePolicy(next: AdminSource["selectionPolicy"], ids?: string[]) {
    try {
      await api(`/api/admin/sources/${source.id}/selection`, {
        method: "PUT",
        body: JSON.stringify({ policy: next, ...(next === "explicit" ? { collectionIds: ids ?? collections.filter((item) => item.selected).map((item) => item.id) } : {}) }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "选择策略更新失败。");
    }
  }

  async function toggleCollection(id: string) {
    const ids = collections.filter((item) => item.selected).map((item) => item.id);
    const next = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
    await updatePolicy("explicit", next);
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api(`/api/admin/sources/${source.id}/collections`, {
        method: "POST",
        body: JSON.stringify({ displayName: data.get("displayName"), docLibId: data.get("docLibId"), rootArchiveId: data.get("rootArchiveId") }),
      });
      form.reset();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登记失败。");
    }
  }

  async function deregister(id: string) {
    if (!window.confirm("确认注销这个致远文档库登记？")) return;
    try {
      await api(`/api/admin/sources/${source.id}/collections/${id}`, { method: "DELETE" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "注销失败。");
    }
  }

  async function excludeCollection(collection: SourceCollection) {
    if (!window.confirm(`确认排除“${collection.displayName}”及其中全部文档？`)) return;
    try {
      await api(`/api/admin/sources/${source.id}/exclusions`, {
        method: "POST",
        body: JSON.stringify({ targetType: "collection", collectionId: collection.id }),
      });
      await load();
      onExclusionsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "排除目录失败。");
    }
  }

  async function restoreCollection(collection: SourceCollection) {
    if (!collection.exclusionRuleId) return;
    try {
      await api(`/api/admin/sources/${source.id}/exclusions/${collection.exclusionRuleId}`, {
        method: "DELETE",
      });
      await load();
      onExclusionsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复目录失败。");
    }
  }

  return (
    <section className="border-t border-[var(--pi-border)] px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">目录选择</h3>
          <p className="mt-0.5 text-xs text-[var(--pi-muted)]">全选会持续纳入以后发现或登记的新目录，明确排除项除外。</p>
        </div>
        <div className="inline-flex rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] p-0.5">
          {(["none", "explicit", "all"] as const).map((value) => (
            <button key={value} type="button" onClick={() => updatePolicy(value)} className={`rounded px-3 py-1.5 text-xs ${policy === value ? "bg-white font-medium text-[var(--pi-brand)] shadow-sm" : "text-[var(--pi-muted)]"}`}>
              {value === "none" ? "不选择" : value === "explicit" ? "按需选择" : "全选"}
            </button>
          ))}
        </div>
      </div>

      {source.kind === "seeyon" ? (
        <form onSubmit={register} className="mt-4 grid gap-3 border-y border-[var(--pi-border)] bg-[var(--pi-bg-soft)] px-3 py-3 md:grid-cols-[1.2fr_1fr_1fr_auto]">
          <Field label="文档库名称"><input name="displayName" required /></Field>
          <Field label="文档库 ID"><input name="docLibId" required inputMode="numeric" /></Field>
          <Field label="根目录 ID"><input name="rootArchiveId" required inputMode="numeric" /></Field>
          <div className="flex items-end"><button className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--pi-border)] bg-white px-3 text-sm"><FolderPlus size={15} />登记</button></div>
        </form>
      ) : null}

      {error ? <p className="mt-3 text-xs text-[var(--pi-danger)]">{error}</p> : null}
      {loading ? <p className="mt-4 text-sm text-[var(--pi-muted)]">正在加载...</p> : collections.length === 0 ? <p className="mt-4 text-sm text-[var(--pi-muted)]">暂无可用目录。</p> : (
        <div className="mt-3 divide-y divide-[var(--pi-border)] border-y border-[var(--pi-border)]">
          {collections.map((item) => (
            <div key={item.id} className="flex items-center gap-3 py-2.5 text-sm">
              <input type="checkbox" aria-label={`选择 ${item.displayName}`} checked={item.selected} disabled={policy !== "explicit" || item.validationState !== "valid"} onChange={() => toggleCollection(item.id)} className="h-4 w-4 accent-[var(--pi-brand)]" />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{item.displayName}</span><span className="block truncate text-xs text-[var(--pi-muted)]">{item.externalId}{item.rootExternalId ? ` / ${item.rootExternalId}` : ""}</span></span>
              <span className={`text-xs ${item.exclusionRuleId ? "text-[var(--pi-danger)]" : item.validationState === "valid" ? "text-[var(--pi-success)]" : item.validationState === "invalid" ? "text-[var(--pi-danger)]" : "text-[var(--pi-muted)]"}`}>{item.exclusionRuleId ? "已排除" : item.validationState}</span>
              <ActionButton
                label={item.exclusionRuleId ? `恢复 ${item.displayName}` : `排除 ${item.displayName}`}
                icon={item.exclusionRuleId ? RotateCcw : CircleSlash2}
                danger={!item.exclusionRuleId}
                onClick={() => item.exclusionRuleId ? restoreCollection(item) : excludeCollection(item)}
              />
              {item.origin === "registered" ? <ActionButton label="注销登记" icon={Trash2} danger disabled={item.selected} onClick={() => deregister(item.id)} /> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

type RuntimeStatus = {
  coverage: {
    totalDocuments: number;
    retrievableDocuments: number;
    queuedDocuments: number;
    indexingDocuments: number;
    failedDocuments: number;
    unsupportedDocuments: number;
    missingFileIdDocuments: number;
    oversizedDocuments: number;
    missingDocuments: number;
    accessRevokedDocuments: number;
    excludedDocuments: number;
    percent: number;
  };
  itemStates: Record<string, number>;
  syncRuns: Array<{
    id: string;
    collectionId: string;
    collectionName: string;
    triggerKind: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    seenItemCount: number;
    changedItemCount: number;
    missingItemCount: number;
    errorSummary: string | null;
  }>;
};

type SourceItem = {
  id: string;
  itemType: string;
  name: string;
  relativePath: string;
  sizeBytes: number | null;
  lifecycleState: string;
  documentStatus: string | null;
  statusReason: string | null;
  hasChildren: boolean;
  exclusionRuleId: string | null;
  excludedByRuleId: string | null;
  excludedByPath: string | null;
};

function SourceRuntimeStatus({
  source,
  externalRevision,
  onExclusionsChanged,
}: {
  source: AdminSource;
  externalRevision: number;
  onExclusionsChanged: () => void;
}) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [collections, setCollections] = useState<SourceCollection[]>([]);
  const [exclusions, setExclusions] = useState<SourceExclusion[]>([]);
  const [collectionId, setCollectionId] = useState("");
  const [items, setItems] = useState<SourceItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [parents, setParents] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState("");
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const itemsContextRef = useRef("");
  const itemsRequestRef = useRef(0);
  const loadMoreRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{ status: RuntimeStatus }>(`/api/admin/sources/${source.id}/status`),
      api<{ collections: SourceCollection[] }>(`/api/admin/sources/${source.id}/collections`),
      api<{ exclusions: SourceExclusion[] }>(`/api/admin/sources/${source.id}/exclusions`),
    ])
      .then(([statusPayload, collectionPayload, exclusionPayload]) => {
        if (cancelled) return;
        setStatus(statusPayload.status);
        setCollections(collectionPayload.collections);
        setExclusions(exclusionPayload.exclusions ?? []);
        setCollectionId((current) =>
          collectionPayload.collections.some((collection) => collection.id === current)
            ? current
            : collectionPayload.collections[0]?.id || "",
        );
        setError("");
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载运行状态。");
      });
    return () => { cancelled = true; };
  }, [source.id, source.updatedAt, externalRevision]);

  const hasActiveSync = Boolean(
    status?.syncRuns.some((run) => run.status === "queued" || run.status === "running"),
  );
  useEffect(() => {
    if (!hasActiveSync) return;
    const timer = window.setTimeout(onExclusionsChanged, 2000);
    return () => window.clearTimeout(timer);
  }, [hasActiveSync, externalRevision, onExclusionsChanged]);

  useEffect(() => {
    setParents([]);
  }, [collectionId]);

  const parentId = parents.at(-1)?.id ?? "";
  useEffect(() => {
    const contextKey = JSON.stringify([source.id, collectionId, parentId]);
    itemsContextRef.current = contextKey;
    const requestId = ++itemsRequestRef.current;
    loadMoreRequestRef.current += 1;
    setLoadingMore(false);
    if (!collectionId) {
      setItems([]);
      setNextCursor(null);
      setLoadingItems(false);
      return;
    }
    setItems([]);
    setNextCursor(null);
    setLoadingItems(true);
    const query = new URLSearchParams({ collectionId });
    if (parentId) query.set("parentId", parentId);
    api<{ items: SourceItem[]; nextCursor: string | null }>(`/api/admin/sources/${source.id}/items?${query}`)
      .then((payload) => {
        if (itemsRequestRef.current !== requestId || itemsContextRef.current !== contextKey) return;
        setItems(payload.items);
        setNextCursor(payload.nextCursor ?? null);
      })
      .catch((cause) => {
        if (itemsRequestRef.current === requestId && itemsContextRef.current === contextKey) {
          setError(cause instanceof Error ? cause.message : "无法加载目录内容。");
        }
      })
      .finally(() => {
        if (itemsRequestRef.current === requestId && itemsContextRef.current === contextKey) {
          setLoadingItems(false);
        }
      });
  }, [source.id, source.updatedAt, collectionId, parentId, externalRevision]);

  async function loadMore() {
    if (!collectionId || !nextCursor || loadingMore) return;
    const contextKey = itemsContextRef.current;
    const cursor = nextCursor;
    const requestId = ++loadMoreRequestRef.current;
    setLoadingMore(true);
    const query = new URLSearchParams({ collectionId, cursor });
    if (parentId) query.set("parentId", parentId);
    try {
      const payload = await api<{ items: SourceItem[]; nextCursor: string | null }>(
        `/api/admin/sources/${source.id}/items?${query}`,
      );
      if (loadMoreRequestRef.current !== requestId || itemsContextRef.current !== contextKey) return;
      setItems((current) => {
        const knownIds = new Set(current.map((item) => item.id));
        return [...current, ...payload.items.filter((item) => !knownIds.has(item.id))];
      });
      setNextCursor(payload.nextCursor ?? null);
    } catch (cause) {
      if (loadMoreRequestRef.current === requestId && itemsContextRef.current === contextKey) {
        setError(cause instanceof Error ? cause.message : "无法加载更多目录内容。");
      }
    } finally {
      if (loadMoreRequestRef.current === requestId && itemsContextRef.current === contextKey) {
        setLoadingMore(false);
      }
    }
  }

  async function excludeItem(item: SourceItem) {
    const target = item.itemType === "folder" ? `目录“${item.name}”及其当前和未来内容` : `文件“${item.name}”`;
    if (!window.confirm(`确认排除${target}？`)) return;
    try {
      await api(`/api/admin/sources/${source.id}/exclusions`, {
        method: "POST",
        body: JSON.stringify({ targetType: "item", sourceItemId: item.id }),
      });
      onExclusionsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "排除项目失败。");
    }
  }

  async function restoreExclusion(ruleId: string) {
    try {
      await api(`/api/admin/sources/${source.id}/exclusions/${ruleId}`, {
        method: "DELETE",
      });
      onExclusionsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复排除项失败。");
    }
  }

  if (!status && !error) {
    return <p className="border-t border-[var(--pi-border)] px-4 py-4 text-sm text-[var(--pi-muted)]">正在加载运行状态...</p>;
  }

  return (
    <section className="border-t border-[var(--pi-border)] px-4 py-4">
      <h3 className="text-sm font-semibold">同步与检索状态</h3>
      {error ? <p className="mt-2 text-xs text-[var(--pi-danger)]">{error}</p> : null}
      {status ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden border border-[var(--pi-border)] bg-[var(--pi-border)] sm:grid-cols-5">
            {[
              ["检索覆盖率", `${status.coverage.percent}%`],
              ["可检索", status.coverage.retrievableDocuments],
              ["文档总数", status.coverage.totalDocuments],
              ["待索引", status.coverage.queuedDocuments],
              ["索引中", status.coverage.indexingDocuments],
              ["失败", status.coverage.failedDocuments],
              ["不支持", status.coverage.unsupportedDocuments],
              ["超限", status.coverage.oversizedDocuments],
              ["缺失", status.coverage.missingDocuments],
              ["无权限", status.coverage.accessRevokedDocuments],
              ["已排除", status.coverage.excludedDocuments ?? 0],
            ].map(([label, value]) => (
              <div key={label} className="bg-white px-3 py-3"><p className="text-[11px] text-[var(--pi-muted)]">{label}</p><p className="mt-1 text-lg font-semibold">{value}</p></div>
            ))}
          </div>

          {source.kind === "seeyon" && status.coverage.missingFileIdDocuments > 0 ? (
            <div className="mt-3 flex items-start gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p>
                已跳过 {status.coverage.missingFileIdDocuments} 个缺少 file_id 的致远条目。
                ReasonKB 无法下载这些内容，因此未建立索引。
              </p>
            </div>
          ) : null}

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-y border-[var(--pi-border)] text-[var(--pi-muted)]"><tr><th className="py-2 font-medium">目录</th><th className="py-2 font-medium">触发</th><th className="py-2 font-medium">状态</th><th className="py-2 font-medium">开始</th><th className="py-2 font-medium">发现</th><th className="py-2 font-medium">变化</th><th className="py-2 font-medium">缺失</th></tr></thead>
              <tbody className="divide-y divide-[var(--pi-border)]">
                {status.syncRuns.length ? status.syncRuns.map((run) => <tr key={run.id}><td className="py-2.5">{run.collectionName}</td><td>{run.triggerKind}</td><td>{run.status}</td><td>{formatDate(run.startedAt)}</td><td>{run.seenItemCount}</td><td>{run.changedItemCount}</td><td>{run.missingItemCount}</td></tr>) : <tr><td colSpan={7} className="py-4 text-center text-[var(--pi-muted)]">暂无同步记录</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-xs font-semibold">排除项</h4>
              <span className="text-xs text-[var(--pi-muted)]">{exclusions.length} 项</span>
            </div>
            {exclusions.length ? (
              <div className="mt-2 divide-y divide-[var(--pi-border)] border-y border-[var(--pi-border)]">
                {exclusions.map((exclusion) => (
                  <div key={exclusion.id} className="flex items-center gap-3 px-2 py-2 text-xs">
                    <CircleSlash2 size={15} className="shrink-0 text-[var(--pi-danger)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{exclusion.displayPath}</span>
                      <span className="block text-[11px] text-[var(--pi-muted)]">
                        {collections.find((collection) => collection.id === exclusion.collectionId)?.displayName ?? exclusion.collectionId}
                        {" · "}
                        {exclusion.targetType === "collection" ? "文档库" : exclusion.targetType === "folder" ? "目录" : "文件"}
                      </span>
                    </span>
                    <ActionButton
                      label={`恢复 ${exclusion.displayPath}`}
                      icon={RotateCcw}
                      onClick={() => restoreExclusion(exclusion.id)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 border-y border-[var(--pi-border)] px-3 py-4 text-center text-xs text-[var(--pi-muted)]">暂无排除项</p>
            )}
          </div>
        </>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <h4 className="mr-2 text-xs font-semibold">源目录浏览</h4>
        <select
          value={collectionId}
          onChange={(event) => { setCollectionId(event.target.value); setParents([]); }}
          className="h-8 max-w-xs rounded-md border border-[var(--pi-border)] bg-white px-2 text-xs"
        >
          <option value="">选择目录</option>
          {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.displayName}</option>)}
        </select>
        {parents.length ? <button type="button" onClick={() => setParents((current) => current.slice(0, -1))} className="h-8 rounded-md border border-[var(--pi-border)] px-2 text-xs">返回上级</button> : null}
        <span className="truncate text-xs text-[var(--pi-muted)]">/{parents.map((parent) => parent.name).join("/")}</span>
      </div>
      {collectionId ? (
        <div className="mt-2 max-h-64 overflow-y-auto border-y border-[var(--pi-border)]">
          {loadingItems ? (
            <p className="px-3 py-4 text-center text-xs text-[var(--pi-muted)]">正在加载目录内容...</p>
          ) : items.length ? items.map((item) => (
            <div key={item.id} className="flex items-center gap-1 border-b border-[var(--pi-border)] px-1 py-1 last:border-0">
              <button
                type="button"
                disabled={item.itemType !== "folder" && !item.hasChildren}
                onClick={() => setParents((current) => [...current, { id: item.id, name: item.name }])}
                className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left text-xs enabled:hover:bg-[var(--pi-bg)] disabled:cursor-default"
              >
                {item.itemType === "folder" ? <Folder size={15} className="shrink-0 text-[var(--pi-brand)]" /> : <FileText size={15} className="shrink-0 text-[var(--pi-muted)]" />}
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="w-24 truncate text-[var(--pi-muted)]">{item.documentStatus ?? item.lifecycleState}</span>
                <span className="w-40 truncate text-[var(--pi-muted)]" title={item.excludedByPath ?? item.statusReason ?? undefined}>{item.excludedByPath ? `由 ${item.excludedByPath} 排除` : item.statusReason ?? "-"}</span>
                <span className="w-20 text-right text-[var(--pi-muted)]">{item.sizeBytes == null ? "" : `${Math.ceil(item.sizeBytes / 1024)} KB`}</span>
              </button>
              <ActionButton
                label={item.exclusionRuleId ? `恢复 ${item.name}` : item.excludedByRuleId ? `${item.name} 已由上级排除` : `排除 ${item.name}`}
                icon={item.exclusionRuleId ? RotateCcw : CircleSlash2}
                danger={!item.exclusionRuleId && !item.excludedByRuleId}
                disabled={Boolean(item.excludedByRuleId && !item.exclusionRuleId)}
                onClick={() => item.exclusionRuleId ? restoreExclusion(item.exclusionRuleId) : excludeItem(item)}
              />
            </div>
          )) : <p className="px-3 py-4 text-center text-xs text-[var(--pi-muted)]">此层级暂无内容</p>}
          {nextCursor ? (
            <button type="button" onClick={loadMore} disabled={loadingMore} className="flex w-full items-center justify-center gap-2 px-3 py-2 text-xs text-[var(--pi-brand)] hover:bg-[var(--pi-bg)] disabled:cursor-wait disabled:opacity-60">
              {loadingMore ? <RefreshCw size={14} className="animate-spin" aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              {loadingMore ? "正在加载..." : "加载更多"}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactElement<{ className?: string }> }) {
  return (
    <label className="block text-xs font-medium text-[var(--pi-muted)]">
      {label}
      <span className="mt-1 block [&>input]:h-9 [&>input]:w-full [&>input]:rounded-md [&>input]:border [&>input]:border-[var(--pi-border)] [&>input]:bg-white [&>input]:px-2.5 [&>input]:text-sm [&>input]:text-[var(--pi-ink)] [&>input]:outline-none [&>select]:h-9 [&>select]:w-full [&>select]:rounded-md [&>select]:border [&>select]:border-[var(--pi-border)] [&>select]:bg-white [&>select]:px-2.5 [&>select]:text-sm [&>select]:text-[var(--pi-ink)]">
        {children}
      </span>
    </label>
  );
}

function CreateSourcePanel({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [kind, setKind] = useState<AdminSource["kind"]>("local");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const common = {
      kind,
      displayName: String(data.get("displayName") ?? "").trim(),
      schedule: {
        mode: data.get("scheduleMode"),
        intervalSeconds: Number(data.get("intervalSeconds")),
        maxDocumentSizeBytes: Number(data.get("maxSizeMb")) * 1024 * 1024,
      },
    };
    const payload = kind === "local" ? {
      ...common, scope: { rootPath: String(data.get("rootPath") ?? "") }, config: {}, credentials: {},
    } : kind === "smb" ? {
      ...common,
      scope: { host: data.get("host"), share: data.get("share"), basePath: data.get("basePath"), port: Number(data.get("port")) },
      config: { authProtocol: data.get("authProtocol") },
      credentials: { username: data.get("username"), password: data.get("password"), domain: data.get("domain") },
    } : {
      ...common,
      scope: { endpoint: data.get("endpoint") },
      config: { loginName: data.get("loginName") },
      credentials: { username: data.get("username"), password: data.get("password") },
    };
    setSaving(true);
    setError("");
    try {
      await api("/api/admin/sources", { method: "POST", body: JSON.stringify(payload) });
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败。");
    } finally {
      setSaving(false);
    }
  }

  const defaultIntervals = { local: 30, smb: 300, seeyon: 600 };
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/25" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="create-source-title" className="rk-scrollbar h-full w-full max-w-xl overflow-y-auto border-l border-[var(--pi-border)] bg-white p-5 shadow-2xl md:p-7">
        <div className="flex items-start justify-between">
          <div><h2 id="create-source-title" className="text-xl font-semibold">新建数据源</h2><p className="mt-1 text-sm text-[var(--pi-muted)]">数据源创建后先验证连接，默认不选择目录。</p></div>
          <ActionButton label="关闭" icon={X} onClick={onClose} />
        </div>
        <div className="mt-6 grid grid-cols-3 rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] p-0.5">
          {(["local", "smb", "seeyon"] as const).map((value) => <button key={value} type="button" onClick={() => setKind(value)} className={`rounded px-2 py-2 text-xs ${kind === value ? "bg-white font-medium text-[var(--pi-brand)] shadow-sm" : "text-[var(--pi-muted)]"}`}>{kindLabels[value]}</button>)}
        </div>
        <form key={kind} onSubmit={submit} className="mt-6 space-y-4">
          <Field label="显示名称"><input name="displayName" required maxLength={120} /></Field>
          {kind === "local" ? <Field label="容器内根路径"><input name="rootPath" required placeholder="/source-data/operations" /></Field> : null}
          {kind === "smb" ? <>
            <div className="grid grid-cols-[1fr_100px] gap-3"><Field label="SMB 主机"><input name="host" required /></Field><Field label="端口"><input name="port" type="number" defaultValue="445" required /></Field></div>
            <Field label="共享名"><input name="share" required /></Field><Field label="共享内根路径"><input name="basePath" placeholder="可留空" /></Field>
            <Field label="认证协议"><select name="authProtocol" defaultValue="ntlm"><option value="ntlm">NTLM</option><option value="negotiate">Negotiate</option></select></Field>
            <Field label="域"><input name="domain" /></Field><Field label="用户名"><input name="username" required autoComplete="off" /></Field><Field label="密码"><input name="password" required type="password" autoComplete="new-password" /></Field>
          </> : null}
          {kind === "seeyon" ? <>
            <Field label="致远地址"><input name="endpoint" required type="url" placeholder="http://seeyon.example.com/seeyon" /></Field>
            <Field label="loginName"><input name="loginName" required /></Field><Field label="REST 用户名"><input name="username" required autoComplete="off" /></Field><Field label="REST 密码"><input name="password" required type="password" autoComplete="new-password" /></Field>
          </> : null}
          <div className="grid grid-cols-3 gap-3">
            <Field label="同步方式"><select name="scheduleMode" defaultValue="scheduled"><option value="scheduled">定时</option><option value="manual">手工</option></select></Field>
            <Field label="间隔（秒）"><input name="intervalSeconds" type="number" required min={kind === "local" ? 5 : kind === "smb" ? 30 : 60} defaultValue={defaultIntervals[kind]} /></Field>
            <Field label="文件上限（MB）"><input name="maxSizeMb" type="number" required min="1" max="1024" defaultValue="100" /></Field>
          </div>
          {error ? <p role="alert" className="text-sm text-[var(--pi-danger)]">{error}</p> : null}
          <div className="flex justify-end gap-2 border-t border-[var(--pi-border)] pt-5"><button type="button" onClick={onClose} className="h-9 rounded-md border border-[var(--pi-border)] px-4 text-sm">取消</button><button disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--pi-brand)] px-4 text-sm font-medium text-white disabled:opacity-50"><Plus size={15} />{saving ? "创建中" : "创建"}</button></div>
        </form>
      </section>
    </div>
  );
}
