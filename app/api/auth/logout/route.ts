import { NextResponse } from "next/server"
import { clearSessionCookies, revokeRefresh } from "@/lib/auth-session"
import { weatherAuth } from "@/lib/weather/firebase-admin"

export async function POST(request: Request) {
  try {
    const header = request.headers.get("authorization")
    if (header?.startsWith("Bearer ")) {
      const decoded = await weatherAuth().verifyIdToken(header.slice(7))
      await weatherAuth().revokeRefreshTokens(decoded.uid)
    }
    await revokeRefresh(request)
  } catch {
    // O logout local continua mesmo se a revogação remota falhar.
  }
  const response = NextResponse.json({ ok: true })
  response.headers.set("Set-Cookie", clearSessionCookies())
  return response
}
