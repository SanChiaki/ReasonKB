import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { listProjects } from "@/lib/repos/project-store";

export async function GET() {
  return NextResponse.json({ projects: listProjects(appConfig.dbPath) });
}
