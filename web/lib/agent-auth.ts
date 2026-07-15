import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import {
  type AgentScope,
  type ApiKeyRecord,
  verifyApiKey,
} from "@/lib/repos/api-key-store";

export type AgentAuthContext = {
  key: ApiKeyRecord;
};

function readApiKey(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] ?? request.headers.get("x-api-key") ?? "";
}

export function requireAgentAuth(
  request: Request,
  requiredScopes: AgentScope[],
): AgentAuthContext | NextResponse {
  const apiKey = readApiKey(request);
  const record = verifyApiKey(appConfig.dbPath, apiKey);
  if (!record) {
    return NextResponse.json({ error: "Invalid or missing API key." }, { status: 401 });
  }

  const missingScopes = requiredScopes.filter(
    (scope) => !record.scopes.includes(scope),
  );
  if (missingScopes.length > 0) {
    return NextResponse.json(
      { error: "API key is missing required scope.", missingScopes },
      { status: 403 },
    );
  }

  return { key: record };
}

export function isAuthResponse(
  value: AgentAuthContext | NextResponse,
): value is NextResponse {
  return value instanceof NextResponse;
}

export function constrainProjectIds(
  requestedProjectIds: string[],
  auth: AgentAuthContext,
) {
  const allowed = auth.key.projectIds;
  if (allowed.length === 0) {
    return [...new Set(requestedProjectIds)];
  }
  if (requestedProjectIds.length === 0) {
    return allowed;
  }
  const requested = [...new Set(requestedProjectIds)];
  const disallowed = requested.filter((projectId) => !allowed.includes(projectId));
  if (disallowed.length > 0) {
    return { error: "API key is not allowed to access one or more projects.", disallowed };
  }
  return requested;
}

export function canAccessProject(projectId: string, auth: AgentAuthContext) {
  return auth.key.projectIds.length === 0 || auth.key.projectIds.includes(projectId);
}
