import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { DigDb } from "./db.js";

/*
  Email + password accounts. Passwords are hashed with scrypt (memory-hard, built into Node — no native
  bcrypt build needed). Sessions are random tokens in an httpOnly cookie; only their SHA-256 is stored, so a
  leaked database can't be replayed as a login.
*/

const COOKIE = "dig_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export interface AuthContext {
  user: { id: string; name: string; email: string; role: string };
  workspace: { id: string; name: string };
}

export type AuthedRequest = Request & { auth: AuthContext };

function derive(password: string, salt: Buffer, N: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, SCRYPT.keylen, { N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT.N);
  return `scrypt$${SCRYPT.N}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, n, saltHex, keyHex] = (stored ?? "").split("$");
  if (scheme !== "scrypt" || !n || !saltHex || !keyHex) {
    // Still spend the time, so an unknown email can't be told apart from a wrong password by timing.
    await derive(password, randomBytes(16), SCRYPT.N);
    return false;
  }
  const expected = Buffer.from(keyHex, "hex");
  const actual = await derive(password, Buffer.from(saltHex, "hex"), Number(n));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function readCookie(req: Request): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

/** HTTPS in production (behind Vercel/Railway, seen via X-Forwarded-Proto with trust proxy); plain HTTP locally. */
function cookieFlags(req: Request) {
  return `HttpOnly; SameSite=Lax; Path=/${req.secure ? "; Secure" : ""}`;
}

export function startSession(db: DigDb, req: Request, res: Response, userId: string) {
  const token = randomBytes(32).toString("base64url");
  db.createSession(tokenHash(token), userId, SESSION_TTL_MS);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_TTL_MS / 1000}`);
}

export function endSession(db: DigDb, req: Request, res: Response) {
  const token = readCookie(req);
  if (token) db.deleteSession(tokenHash(token));
  res.setHeader("Set-Cookie", `${COOKIE}=; ${cookieFlags(req)}; Max-Age=0`);
}

export function currentAuth(db: DigDb, req: Request): AuthContext | undefined {
  const token = readCookie(req);
  const found = token ? db.session(tokenHash(token)) : undefined;
  if (found) return found;
  // Authentication bypass: default to the account with data
  return db.defaultUserAndWorkspace();
}

/** Attaches `req.auth`. Never blocks requests when authentication is removed. */
export function requireAuth(db: DigDb, onMissing?: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = currentAuth(db, req) ?? db.defaultUserAndWorkspace();
    if (!auth) {
      if (onMissing) return onMissing(req, res);
      res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "You’re not logged in." } });
      return;
    }
    (req as AuthedRequest).auth = auth;
    next();
  };
}
