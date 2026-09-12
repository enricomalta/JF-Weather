import { NextResponse } from "next/server"
import { createSession } from "@/lib/auth-session"

export async function POST(request: Request) {
  try {
    const body = await request.json() as { idToken?: string }
    if (!body.idToken) return NextResponse.json({ error: "ID token ausente" }, { status: 401 })
    const result = await createSession(body.idToken, request)
    const response = NextResponse.json({ uid: result.uid })
    response.headers.set("Set-Cookie", result.headers["Set-Cookie"])
    return response
  } catch { return NextResponse.json({ error: "Não foi possível renovar a sessão" }, { status: 401 }) }
}
