import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import {
  createAdminSession,
  isAdminConfigured,
  verifyAdminCredentials,
} from "@/lib/repos/admin-auth-store";
import {
  setAdminCsrfCookie,
  setAdminSessionCookie,
} from "@/lib/security/admin-route-auth";

const schema = z.object({ password: z.string().min(1).max(1024) });

export async function POST(request: Request) {
  if (!isAdminConfigured(appConfig.dbPath)) {
    return NextResponse.json(
      { error: "Administrator account is not configured." },
      { status: 503 },
    );
  }
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }
  if (!verifyAdminCredentials(appConfig.dbPath, parsed.data.password)) {
    return NextResponse.json({ error: "Invalid administrator password." }, { status: 401 });
  }
  const session = createAdminSession(appConfig.dbPath);
  const response = NextResponse.json({
    authenticated: true,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  });
  setAdminSessionCookie(response, session.token, session.expiresAt);
  setAdminCsrfCookie(response, session.csrfToken, session.expiresAt);
  return response;
}
