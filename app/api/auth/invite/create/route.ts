import { FieldValue, weatherAuth, weatherDb } from "@/lib/weather/firebase-admin";

function generateCode() {
  return Array.from({ length: 12 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const idToken = typeof body.idToken === "string" ? body.idToken : "";
    if (!idToken) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const decoded = await weatherAuth().verifyIdToken(idToken);
    const adminDoc = await weatherDb().collection("users").doc(decoded.uid).get();
    if (adminDoc.data()?.admin !== true) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await weatherDb().collection("inviteCodes").doc(code).set({
      code,
      valid: true,
      createdBy: decoded.uid,
      criadoPor: decoded.uid,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      usedBy: null,
      usedAt: null,
    });
    return Response.json({ code, expiresAt: expiresAt.toISOString() });
  } catch {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
}
