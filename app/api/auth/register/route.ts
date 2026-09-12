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
    const body = await request.json() as { idToken?: string; code?: string; name?: string; newUser?: boolean }
    if (!body.idToken || !body.code || !/^[A-Za-z0-9_-]{4,128}$/.test(body.code)) {
      return NextResponse.json({ error: "INVITE_INVALID" }, { status: 400 })
    }

    const decoded = await getAuth().verifyIdToken(body.idToken)
    const db = weatherDb()
    const inviteRef = db.collection("inviteCodes").doc(body.code)
    const userRef = db.collection("users").doc(decoded.uid)

    try {
      await db.runTransaction(async (transaction) => {
        const invite = await transaction.get(inviteRef)
        const existingUser = await transaction.get(userRef)
        if (!invite.exists || !isValidInvite(invite.data())) throw new Error("INVITE_INVALID")
        if (existingUser.exists) throw new Error("USER_ALREADY_REGISTERED")

        transaction.create(userRef, {
          uid: decoded.uid,
          name: body.name?.trim() || decoded.name || null,
          email: decoded.email || null,
          photoURL: decoded.picture || null,
          createdAt: FieldValue.serverTimestamp(),
          notificationsEnabled: false,
          fcmTokens: {},
          lastLoginAt: FieldValue.serverTimestamp(),
        })
        transaction.update(inviteRef, {
          valid: false,
          usedAt: FieldValue.serverTimestamp(),
          usedBy: decoded.uid,
        })
      })
    } catch (error) {
      // Auth and Firestore do not share a transaction coordinator. Roll back a
      // newly-created Auth account if the atomic Firestore commit is rejected.
      if (body.newUser && error instanceof Error && error.message !== "INVITE_INVALID" && error.message !== "USER_ALREADY_REGISTERED") {
        await getAuth().deleteUser(decoded.uid).catch(() => undefined)
      }
      throw error
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof Error && error.message === "INVITE_INVALID") {
      return NextResponse.json({ error: "INVITE_INVALID" }, { status: 409 })
    }
    return NextResponse.json({ error: "REGISTER_FAILED" }, { status: 500 })
  }
}
