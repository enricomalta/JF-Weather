import { weatherAuth, weatherDb } from "@/lib/weather/firebase-admin";

export async function GET(request: Request) {
  try {
    const authorization = request.headers.get("authorization");
    const idToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!idToken) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const decoded = await weatherAuth().verifyIdToken(idToken);
    const snapshot = await weatherDb().collection("users").doc(decoded.uid).get();
    const data = snapshot.data() ?? {};
    return Response.json({
      admin: data.admin === true,
      notificationsEnabled: data.notificationsEnabled === true,
    });
  } catch {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
}
