import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { parseCorpusSourceUpdate } from "@/lib/corpus-source-input";
import {
  getCorpusSource,
  updateCorpusSource,
} from "@/lib/repos/corpus-source-store";
import { requestCorpusSourcePurge } from "@/lib/repos/source-lifecycle-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";
import { loadMasterKey } from "@/lib/security/source-credentials";

type RouteContext = { params: Promise<{ sourceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) {
    return unauthorizedAdminResponse();
  }
  const { sourceId } = await context.params;
  const source = getCorpusSource(appConfig.dbPath, sourceId);
  return source
    ? NextResponse.json({ source })
    : NextResponse.json({ error: "Corpus Source not found." }, { status: 404 });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { sourceId } = await context.params;
  const existing = getCorpusSource(appConfig.dbPath, sourceId);
  if (!existing) {
    return NextResponse.json({ error: "Corpus Source not found." }, { status: 404 });
  }
  const parsed = parseCorpusSourceUpdate(
    existing.kind as "local" | "smb" | "seeyon",
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload.", details: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const source = updateCorpusSource(
      appConfig.dbPath,
      loadMasterKey(appConfig.masterKeyPath),
      sourceId,
      parsed.data,
    );
    return NextResponse.json({ source });
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return NextResponse.json(
        { error: "A Corpus Source with this display name already exists." },
        { status: 409 },
      );
    }
    if (error instanceof Error && /master key|ENOENT/.test(error.message)) {
      return NextResponse.json(
        { error: "Source credential encryption is not configured." },
        { status: 503 },
      );
    }
    if (error instanceof Error && error.message.includes("active Seeyon URL migration")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { sourceId } = await context.params;
  const source = getCorpusSource(appConfig.dbPath, sourceId);
  if (!source) {
    return NextResponse.json({ error: "Corpus Source not found." }, { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    immediate?: unknown;
    confirmation?: unknown;
  };
  const immediate = body.immediate === true;
  if (immediate && body.confirmation !== source.displayName) {
    return NextResponse.json(
      { error: "Enter the Corpus Source display name to confirm immediate purge." },
      { status: 400 },
    );
  }
  try {
    const result = requestCorpusSourcePurge(appConfig.dbPath, sourceId, { immediate });
    return NextResponse.json({ pendingPurge: true, purgeAfter: result!.purgeAfter });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to purge Corpus Source.";
    return NextResponse.json(
      { error: message },
      { status: message.includes("active Seeyon URL migration") ? 409 : 400 },
    );
  }
}
