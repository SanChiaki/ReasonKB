import fs from "node:fs";
import path from "node:path";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatEnvValue(value: string) {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function updateEnvFileValue(envFilePath: string, key: string, value: string) {
  if (!envFilePath) {
    return false;
  }

  fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
  const existing = fs.existsSync(envFilePath)
    ? fs.readFileSync(envFilePath, "utf-8")
    : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
  const nextLine = `${key}=${formatEnvValue(value)}`;
  let wrote = false;
  const nextLines: string[] = [];

  for (const line of lines) {
    if (matcher.test(line)) {
      if (!wrote) {
        nextLines.push(nextLine);
        wrote = true;
      }
      continue;
    }
    nextLines.push(line);
  }

  if (!wrote) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }
    nextLines.push(nextLine);
  }

  fs.writeFileSync(envFilePath, `${nextLines.join("\n").replace(/\n*$/, "")}\n`);
  return true;
}
