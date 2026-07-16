import { AdminLoginForm } from "@/components/admin-login-form";
import { redirectAuthenticatedAdmin } from "@/lib/security/admin-page-auth";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ passwordChanged?: string }>;
}) {
  await redirectAuthenticatedAdmin();
  const params = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--pi-bg)] px-5">
      <AdminLoginForm
        notice={params.passwordChanged === "1" ? "管理员密码已修改，请重新登录。" : ""}
      />
    </main>
  );
}
