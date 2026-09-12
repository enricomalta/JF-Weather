import { getAuth } from "firebase-admin/auth"
import { FieldValue, weatherDb } from "@/lib/weather/firebase-admin"
import { NextResponse } from "next/server"

function isValidInvite(data: FirebaseFirestore.DocumentData | undefined) {
  if (!data || data.valid === false || data.usedAt) return false
  const expiresAt = data.expiresAt?.toMillis?.() ?? data.expiresAt?.toDate?.()?.getTime()
  return !expiresAt || expiresAt >= Date.now()
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { idToken?: string; code?: string; name?: string }
    if (!body.idToken || !body.code || !/^[A-Za-z0-9_-]{4,128}$/.test(body.code)) {
      return NextResponse.json({ error: "INVITE_INVALID" }, { status: 400 })
    }

    const decoded = await getAuth().verifyIdToken(body.idToken)
    const db = weatherDb()
    const inviteRef = db.collection("inviteCodes").doc(body.code)
    const userRef = db.collection("users").doc(decoded.uid)

    await db.runTransaction(async (transaction) => {
      const invite = await transaction.get(inviteRef)
      if (!invite.exists || !isValidInvite(invite.data())) throw new Error("INVITE_INVALID")
      transaction.set(userRef, {
        uid: decoded.uid,
        name: body.name?.trim() || decoded.name || null,
        email: decoded.email || null,
        photoURL: decoded.picture || null,
        createdAt: FieldValue.serverTimestamp(),
        notificationsEnabled: false,
        lastLoginAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      transaction.update(inviteRef, { usedAt: FieldValue.serverTimestamp(), usedBy: decoded.uid })
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof Error && error.message === "INVITE_INVALID") {
      return NextResponse.json({ error: "INVITE_INVALID" }, { status: 409 })
    }
    return NextResponse.json({ error: "REGISTER_FAILED" }, { status: 500 })
  }
}
