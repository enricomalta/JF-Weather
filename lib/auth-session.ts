import { FieldValue, weatherAuth, weatherDb } from "@/lib/weather/firebase-admin"
import crypto from "node:crypto"

const SESSION_COOKIE = "jf_session"
const REFRESH_COOKIE = "jf_refresh"
const SESSION_DAYS = 7

function adminAuth() { return weatherAuth() }
function hash(value: string) { return crypto.createHash("sha256").update(value).digest("hex") }
function cookie(name: string, value: string, maxAge: number) { return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure` }

export async function createSession(idToken: string, request: Request) {
  weatherDb()
  const decoded = await adminAuth().verifyIdToken(idToken)
  const sessionCookie = await adminAuth().createSessionCookie(idToken, { expiresIn: SESSION_DAYS * 24 * 60 * 60 * 1000 })
  const refreshToken = crypto.randomBytes(48).toString("base64url")
  const now = Date.now()
  const ref = weatherDb().collection("sessions").doc()
  await ref.set({ userId: decoded.uid, refreshTokenHash: hash(refreshToken), createdAt: FieldValue.serverTimestamp(), expiresAt: new Date(now + SESSION_DAYS * 86400000), revokedAt: null, userAgent: request.headers.get("user-agent") ?? null })
  await weatherDb().collection("users").doc(decoded.uid).set({ uid: decoded.uid, email: decoded.email ?? null, name: decoded.name ?? null, photoURL: decoded.picture ?? null, lastLoginAt: FieldValue.serverTimestamp() }, { merge: true })
  return { headers: { "Set-Cookie": `${cookie(SESSION_COOKIE, sessionCookie, SESSION_DAYS * 86400)}, ${cookie(REFRESH_COOKIE, `${ref.id}.${refreshToken}`, SESSION_DAYS * 86400)}` }, uid: decoded.uid }
}

export async function refreshSession(request: Request) {
  const raw = request.headers.get("cookie")?.match(new RegExp(`${REFRESH_COOKIE}=([^;]+)`))?.[1]
  if (!raw) throw new Error("NO_REFRESH")
  const [id, token] = raw.split(".")
  const ref = weatherDb().collection("sessions").doc(id)
  const snapshot = await ref.get(); const data = snapshot.data()
  if (!snapshot.exists || !data || data.revokedAt || data.refreshTokenHash !== hash(token) || data.expiresAt.toMillis() < Date.now()) throw new Error("INVALID_REFRESH")
  await ref.update({ revokedAt: FieldValue.serverTimestamp() })
  const user = await adminAuth().getUser(data.userId)
  return createSession(await adminAuth().createCustomToken(user.uid), request)
}

export function sessionCookies() { return { SESSION_COOKIE, REFRESH_COOKIE } }
export function clearSessionCookies() { return `${cookie(SESSION_COOKIE, "", 0)}, ${cookie(REFRESH_COOKIE, "", 0)}` }
export async function revokeRefresh(request: Request) { const raw = request.headers.get("cookie")?.match(new RegExp(`${REFRESH_COOKIE}=([^;]+)`))?.[1]; if (!raw) return; const [id] = raw.split("."); await weatherDb().collection("sessions").doc(id).update({ revokedAt: FieldValue.serverTimestamp() }).catch(() => undefined) }
export async function verifySessionCookie(value: string) { return adminAuth().verifySessionCookie(value, true) }
