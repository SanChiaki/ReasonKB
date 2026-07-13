import { AdminShell } from "@/components/admin-shell";
import { appConfig } from "@/lib/config";
import { listAdminAuditEvents } from "@/lib/repos/source-observability-store";
import { requireAdminPage } from "@/lib/security/admin-page-auth";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requireAdminPage();
  const events = listAdminAuditEvents(appConfig.dbPath, 200);
  return (
    <AdminShell>
      <header className="border-b border-[var(--pi-border)] pb-5">
        <p className="text-[11px] font-semibold uppercase text-[var(--pi-muted)]">Administration history</p>
        <h1 className="mt-1 text-2xl font-semibold">管理员审计</h1>
        <p className="mt-1 text-sm text-[var(--pi-muted)]">最近 200 条数据源、目录和凭据管理操作。</p>
      </header>
      <div className="mt-5 overflow-x-auto border-y border-[var(--pi-border)] bg-white">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead className="border-b border-[var(--pi-border)] text-[var(--pi-muted)]">
            <tr><th className="px-3 py-2.5 font-medium">时间</th><th className="px-3 py-2.5 font-medium">操作</th><th className="px-3 py-2.5 font-medium">对象类型</th><th className="px-3 py-2.5 font-medium">对象 ID</th><th className="px-3 py-2.5 font-medium">结果</th><th className="px-3 py-2.5 font-medium">错误</th></tr>
          </thead>
          <tbody className="divide-y divide-[var(--pi-border)]">
            {events.length ? events.map((event) => (
              <tr key={String(event.id)}>
                <td className="whitespace-nowrap px-3 py-2.5">{new Date(String(event.createdAt)).toLocaleString("zh-CN", { hour12: false })}</td>
                <td className="px-3 py-2.5 font-medium">{String(event.action)}</td>
                <td className="px-3 py-2.5">{String(event.targetType)}</td>
                <td className="max-w-[280px] truncate px-3 py-2.5 font-mono text-[11px]">{event.targetId ? String(event.targetId) : "-"}</td>
                <td className="px-3 py-2.5">{String(event.outcome)}</td>
                <td className="max-w-[320px] truncate px-3 py-2.5 text-[var(--pi-danger)]">{event.errorSummary ? String(event.errorSummary) : ""}</td>
              </tr>
            )) : <tr><td colSpan={6} className="px-3 py-10 text-center text-[var(--pi-muted)]">暂无审计记录</td></tr>}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
