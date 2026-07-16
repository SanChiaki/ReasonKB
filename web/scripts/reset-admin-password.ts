import fs from "node:fs";
import { appConfig } from "@/lib/config";
import { resetAdminPassword } from "@/lib/repos/admin-auth-store";

const input = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");

if (input.includes("\n") || input.includes("\r")) {
  throw new Error("Administrator password must be provided as a single line.");
}

resetAdminPassword(appConfig.dbPath, input);
console.log("Administrator password reset successfully; all administrator sessions were revoked.");
