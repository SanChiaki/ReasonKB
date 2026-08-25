import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import { confirmSourceMigration } from "@/lib/repos/source-migration-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

const schema = z.object({ migrationId: z.string().trim().min(1) }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid migration confirmation." }, { status: 400 });
  }
  const { sourceId } = await context.params;
  try {
    const migration = confirmSourceMigration(appConfig.dbPath, sourceId, parsed.data.migrationId);
    return NextResponse.json({ migration }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to confirm source migration.";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
