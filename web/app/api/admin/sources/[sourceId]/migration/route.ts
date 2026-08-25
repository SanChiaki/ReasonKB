import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { parseSeeyonSourceMigration } from "@/lib/corpus-source-input";
import { getCorpusSource } from "@/lib/repos/corpus-source-store";
import {
  cancelSourceMigration,
  latestSourceMigration,
  requestSeeyonSourceMigration,
} from "@/lib/repos/source-migration-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";
import { loadMasterKey } from "@/lib/security/source-credentials";

type RouteContext = { params: Promise<{ sourceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) return unauthorizedAdminResponse();
  const { sourceId } = await context.params;
  const source = getCorpusSource(appConfig.dbPath, sourceId);
  if (!source) return NextResponse.json({ error: "Corpus Source not found." }, { status: 404 });
  return NextResponse.json({ migration: latestSourceMigration(appConfig.dbPath, sourceId) });
}

export async function POST(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { sourceId } = await context.params;
  const parsed = parseSeeyonSourceMigration(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid migration request.", details: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const migration = requestSeeyonSourceMigration(
      appConfig.dbPath,
      loadMasterKey(appConfig.masterKeyPath),
      sourceId,
      parsed.data,
    );
    return NextResponse.json({ migration }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start source migration.";
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 409 },
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { sourceId } = await context.params;
  const migration = cancelSourceMigration(appConfig.dbPath, sourceId);
  return migration
    ? NextResponse.json({ migration })
    : NextResponse.json({ error: "No active source migration." }, { status: 404 });
}
