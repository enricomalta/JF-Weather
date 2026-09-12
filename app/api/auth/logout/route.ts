import { NextResponse } from "next/server"
import { clearSessionCookies, revokeRefresh } from "@/lib/auth-session"

export async function POST(request: Request) {
  await revokeRefresh(request)
  const response = NextResponse.json({ ok: true })
  response.headers.set("Set-Cookie", clearSessionCookies())
  return response
}
