import { NextResponse } from "next/server"
import { FieldValue, weatherAuth, weatherDb } from "@/lib/weather/firebase-admin"

export async function POST(request: Request) {
  try {
    const body = await request.json() as { idToken?: string; fcmToken?: string }
    if (!body.idToken || !body.fcmToken) return NextResponse.json({ error: "Dados ausentes" }, { status: 400 })
    const user = await weatherAuth().verifyIdToken(body.idToken)
    await weatherDb().collection("users").doc(user.uid).set({
      notificationsEnabled: true,
      fcmTokens: { [body.fcmToken]: true },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: "Não foi possível registrar o token" }, { status: 401 })
  }
}
