import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

type DirectoryEntry = {
  name: string;
  browsePath: string;
  hostPath: string;
};

function toBrowsePath(relativePath: string) {
  const normalized = relativePath
    .split(path.sep)
    .filter(Boolean)
    .join("/");
  return normalized ? `/${normalized}` : "/";
}

function toRelativeBrowsePath(value: string | null) {
  const raw = value?.trim() || "/";
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) {
    throw new Error("Invalid browse path.");
  }
  return parts.join(path.sep);
}

function joinHostPath(hostRoot: string, relativePath: string) {
  const normalizedRelative = relativePath
    .split(path.sep)
    .filter(Boolean)
    .join("/");
  const trimmedRoot = hostRoot.replace(/[\\/]+$/, "");
  return normalizedRelative ? `${trimmedRoot}/${normalizedRelative}` : trimmedRoot;
}

function isInsideRoot(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function GET(request: Request) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) {
    return unauthorizedAdminResponse();
  }
  const rootContainerPath = appConfig.hostBrowseRootContainerPath;
  const rootHostPath = appConfig.hostBrowseRootHostPath;
  if (!rootContainerPath || !rootHostPath) {
    return NextResponse.json(
      { error: "Host directory browser is not configured." },
      { status: 503 },
    );
  }

  let relativePath = "";
  try {
    const url = new URL(request.url);
    relativePath = toRelativeBrowsePath(url.searchParams.get("path"));
  } catch {
    return NextResponse.json({ error: "Invalid browse path." }, { status: 400 });
  }

  const rootPath = path.resolve(rootContainerPath);
  const targetPath = path.resolve(rootPath, relativePath);
  if (!isInsideRoot(rootPath, targetPath)) {
    return NextResponse.json({ error: "Invalid browse path." }, { status: 400 });
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(targetPath);
  } catch {
    return NextResponse.json({ error: "Directory not found." }, { status: 404 });
  }
  if (!stats.isDirectory()) {
    return NextResponse.json({ error: "Path is not a directory." }, { status: 400 });
  }

  let entries: DirectoryEntry[];
  try {
    entries = fs
      .readdirSync(targetPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const entryRelativePath = path.join(relativePath, entry.name);
        return {
          name: entry.name,
          browsePath: toBrowsePath(entryRelativePath),
          hostPath: joinHostPath(rootHostPath, entryRelativePath),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return NextResponse.json(
      { error: "Unable to read host directories." },
      { status: 500 },
    );
  }

  const parentDirectory = relativePath ? path.dirname(relativePath) : "";
  const parentRelativePath = parentDirectory === "." ? "" : parentDirectory;
  return NextResponse.json({
    rootHostPath,
    currentBrowsePath: toBrowsePath(relativePath),
    currentHostPath: joinHostPath(rootHostPath, relativePath),
    parentBrowsePath: relativePath ? toBrowsePath(parentRelativePath) : null,
    entries,
  });
}
