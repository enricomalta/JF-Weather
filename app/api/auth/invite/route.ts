import { NextResponse } from "next/server"
import { weatherDb } from "@/lib/weather/firebase-admin"

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code")?.trim()
  if (!code || !/^[A-Za-z0-9_-]{4,128}$/.test(code)) {
    return NextResponse.json({ valid: false }, { status: 400 })
  }

  try {
    const snapshot = await weatherDb().collection("inviteCodes").doc(code).get()
    const data = snapshot.data() as { valid?: boolean; usedAt?: unknown; expiresAt?: { toDate?: () => Date; toMillis?: () => number } } | undefined
    const expiresAt = data?.expiresAt?.toMillis?.() ?? data?.expiresAt?.toDate?.().getTime()
    const valid = snapshot.exists && data?.valid !== false && !data?.usedAt && (!expiresAt || expiresAt >= Date.now())
    return NextResponse.json({ valid })
  } catch {
    return NextResponse.json({ valid: false }, { status: 500 })
  }
}
