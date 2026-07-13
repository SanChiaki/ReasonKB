import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { appConfig } from "@/lib/config";
import { validateAdminSession } from "@/lib/repos/admin-auth-store";
import { ADMIN_SESSION_COOKIE } from "@/lib/security/admin-route-auth";

export async function requireAdminPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token || !validateAdminSession(appConfig.dbPath, token)) {
    redirect("/admin/login");
  }
}

export async function redirectAuthenticatedAdmin() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  if (token && validateAdminSession(appConfig.dbPath, token)) {
    redirect("/admin/sources");
  }
}
