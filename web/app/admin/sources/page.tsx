import { AdminShell } from "@/components/admin-shell";
import {
  AdminSourceManager,
  type AdminSource,
} from "@/components/admin-source-manager";
import { appConfig } from "@/lib/config";
import { listCorpusSources } from "@/lib/repos/corpus-source-store";
import { requireAdminPage } from "@/lib/security/admin-page-auth";

export const dynamic = "force-dynamic";

export default async function AdminSourcesPage() {
  await requireAdminPage();
  const sources = listCorpusSources(appConfig.dbPath) as AdminSource[];
  return (
    <AdminShell>
      <AdminSourceManager initialSources={sources} />
    </AdminShell>
  );
}
