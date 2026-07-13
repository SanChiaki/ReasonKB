import { AdminLoginForm } from "@/components/admin-login-form";
import { redirectAuthenticatedAdmin } from "@/lib/security/admin-page-auth";

export default async function AdminLoginPage() {
  await redirectAuthenticatedAdmin();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--pi-bg)] px-5">
      <AdminLoginForm />
    </main>
  );
}
