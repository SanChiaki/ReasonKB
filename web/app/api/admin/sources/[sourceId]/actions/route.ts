import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import {
  disableCorpusSource,
  enableCorpusSource,
  queueManualSourceSync,
  requestSourceValidation,
  restoreCorpusSource,
} from "@/lib/repos/source-lifecycle-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

const schema = z
  .object({ action: z.enum(["validate", "enable", "disable", "sync", "restore"]) })
  .strict();

type RouteContext = { params: Promise<{ sourceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload.", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const { sourceId } = await context.params;
  try {
    if (parsed.data.action === "sync") {
      return NextResponse.json(queueManualSourceSync(appConfig.dbPath, sourceId));
    }
    const changed =
      parsed.data.action === "validate"
        ? requestSourceValidation(appConfig.dbPath, sourceId)
        : parsed.data.action === "enable"
          ? enableCorpusSource(appConfig.dbPath, sourceId)
          : parsed.data.action === "disable"
            ? disableCorpusSource(appConfig.dbPath, sourceId)
            : restoreCorpusSource(appConfig.dbPath, sourceId);
    return changed
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Corpus Source not found." }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source action failed.";
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 409 },
    );
  }
}
