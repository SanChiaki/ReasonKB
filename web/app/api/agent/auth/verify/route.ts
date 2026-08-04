import { NextResponse } from "next/server";
import { isAuthResponse, requireAgentAuth } from "@/lib/agent-auth";

export async function POST(request: Request) {
  const auth = requireAgentAuth(request, [], { recordUsage: false });
  if (isAuthResponse(auth)) {
    return auth;
  }
  return NextResponse.json({ scopes: auth.key.scopes });
}
