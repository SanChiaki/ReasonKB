import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import {
  createCorpusSourceSchema,
  normalizeCorpusSourceInput,
} from "@/lib/corpus-source-input";
import {
  createCorpusSource,
  listCorpusSources,
} from "@/lib/repos/corpus-source-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";
import { loadMasterKey } from "@/lib/security/source-credentials";

export async function GET(request: Request) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) {
    return unauthorizedAdminResponse();
  }
  return NextResponse.json({ sources: listCorpusSources(appConfig.dbPath) });
}

export async function POST(request: Request) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const parsed = createCorpusSourceSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload.", details: parsed.error.issues },
      { status: 400 },
    );
  }
  let input;
  try {
    input = normalizeCorpusSourceInput(
      parsed.data,
      appConfig.localSourceAccessRoot,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid source configuration." },
      { status: 400 },
    );
  }
  try {
    const source = createCorpusSource(
      appConfig.dbPath,
      loadMasterKey(appConfig.masterKeyPath),
      input,
    );
    return NextResponse.json({ source }, { status: 201 });
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
    throw error;
  }
}
