import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import {
  isAuthResponse,
  requireAgentAuth,
} from "@/lib/agent-auth";
import { listProjects } from "@/lib/repos/project-store";

export async function GET(request: Request) {
  const auth = requireAgentAuth(request, ["read:projects"]);
  if (isAuthResponse(auth)) {
    return auth;
  }

  const projects = listProjects(appConfig.dbPath).filter(
    (project) =>
      auth.key.projectIds.length === 0 || auth.key.projectIds.includes(project.id),
  );
  return NextResponse.json({ projects });
}
