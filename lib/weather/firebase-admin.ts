import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { getMessaging } from "firebase-admin/messaging"

function getAdminApp() {
  const existing = getApps()[0]
  if (existing) return existing
  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
  if (!projectId || !clientEmail || !privateKey) throw new Error("Credenciais do Firebase não configuradas")
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
}

export function weatherDb() {
  return getFirestore(getAdminApp())
}

export const WEATHER_COLLECTION = "weatherNeighborhoods"
export const WEATHER_META_COLLECTION = "weatherUpdates"
export const WEATHER_META_DOCUMENT = "latest"

export const RAINVIEWER_COLLECTION = "rainViewerHistory";
export const RAINVIEWER_DOCUMENT = "juiz-de-fora";

export function refreshSecretIsValid(request: Request) {
  const header = request.headers.get("authorization")
  const expected = process.env.WEATHER_REFRESH_SECRET
  return Boolean(expected && header === `Bearer ${expected}`)
}

export async function sendDiscordAlert(content: string) {
  const webhook = process.env.DISCORD_WEBHOOK_URL
  if (!webhook) return
  await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) })
}

export async function sendPushToEnabledUsers(title: string, body: string) {
  const snapshot = await weatherDb().collection("users").where("notificationsEnabled", "==", true).get()
  const tokens = snapshot.docs.flatMap((item) => Object.keys((item.data().fcmTokens ?? {}) as Record<string, boolean>))
  if (!tokens.length) return { successCount: 0, failureCount: 0 }
  const result = await getMessaging().sendEachForMulticast({ tokens, notification: { title, body } })
  return { successCount: result.successCount, failureCount: result.failureCount }
}

export function serializeFirestore<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export { FieldValue } from "firebase-admin/firestore"

