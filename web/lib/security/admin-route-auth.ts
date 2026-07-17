import { NextResponse } from "next/server";
import { validateAdminSession } from "@/lib/repos/admin-auth-store";

export const ADMIN_SESSION_COOKIE = "reasonkb_admin_session";
export const ADMIN_CSRF_COOKIE = "reasonkb_admin_csrf";
export const ADMIN_CSRF_HEADER = "x-reasonkb-csrf";

export function adminCookieIsSecure(request: Request) {
  const configured = process.env.REASONKB_ADMIN_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "true") {
    return true;
  }
  if (configured === "false") {
    return false;
  }

  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProtocol) {
    return forwardedProtocol === "https";
  }
  return new URL(request.url).protocol === "https:";
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie");
  if (!cookies) {
    return null;
  }
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = pair.slice(0, separator).trim();
    if (key === name) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }
  return null;
}

export function adminSessionToken(request: Request) {
  return cookieValue(request, ADMIN_SESSION_COOKIE);
}

export function authorizeAdminRequest(
  request: Request,
  dbPath: string,
  options: { requireCsrf?: boolean } = {},
) {
  const token = adminSessionToken(request);
  if (!token) {
    return null;
  }
  const csrfToken = options.requireCsrf
    ? request.headers.get(ADMIN_CSRF_HEADER) ?? undefined
    : undefined;
  if (options.requireCsrf && !csrfToken) {
    return null;
  }
  return validateAdminSession(dbPath, token, csrfToken);
}

export function unauthorizedAdminResponse() {
  return NextResponse.json({ error: "Administrator authentication required." }, { status: 401 });
}

export function setAdminSessionCookie(
  response: NextResponse,
  request: Request,
  token: string,
  expiresAt: string,
) {
  response.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "strict",
    secure: adminCookieIsSecure(request),
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function setAdminCsrfCookie(
  response: NextResponse,
  request: Request,
  csrfToken: string,
  expiresAt: string,
) {
  response.cookies.set({
    name: ADMIN_CSRF_COOKIE,
    value: csrfToken,
    httpOnly: false,
    sameSite: "strict",
    secure: adminCookieIsSecure(request),
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearAdminSessionCookie(response: NextResponse, request: Request) {
  const secure = adminCookieIsSecure(request);
  response.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    expires: new Date(0),
  });
  response.cookies.set({
    name: ADMIN_CSRF_COOKIE,
    value: "",
    httpOnly: false,
    sameSite: "strict",
    secure,
    path: "/",
    expires: new Date(0),
  });
}
