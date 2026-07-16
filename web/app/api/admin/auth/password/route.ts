import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import { replaceAdminPassword } from "@/lib/repos/admin-auth-store";
import {
  authorizeAdminRequest,
  clearAdminSessionCookie,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

const schema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
});

export async function PATCH(request: Request) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: "invalid_password",
        error: "The new administrator password must contain 12 to 1024 characters.",
      },
      { status: 400 },
    );
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return NextResponse.json(
      {
        code: "password_unchanged",
        error: "The new administrator password must be different.",
      },
      { status: 400 },
    );
  }
  if (
    !replaceAdminPassword(
      appConfig.dbPath,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    )
  ) {
    return NextResponse.json(
      { code: "invalid_current_password", error: "The current password is incorrect." },
      { status: 400 },
    );
  }

  const response = NextResponse.json({ changed: true });
  clearAdminSessionCookie(response);
  return response;
}
