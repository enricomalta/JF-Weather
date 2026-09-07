import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

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

export function serializeFirestore<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export { FieldValue } from "firebase-admin/firestore"

