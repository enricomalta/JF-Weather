import crypto from "node:crypto"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore"

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")

if (!projectId || !clientEmail || !privateKey) {
  throw new Error("FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY são obrigatórios.")
}

const app = getApps()[0] ?? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
const db = getFirestore(app)
const days = Number(process.argv[2] ?? 30)

if (!Number.isInteger(days) || days < 1 || days > 365) {
  throw new Error("Informe a validade em dias como um número inteiro entre 1 e 365.")
}

const code = crypto.randomBytes(6).toString("hex").toUpperCase()
const expiresAt = Timestamp.fromMillis(Date.now() + days * 24 * 60 * 60 * 1000)

await db.collection("inviteCodes").doc(code).create({
  code,
  valid: true,
  createdAt: FieldValue.serverTimestamp(),
  expiresAt,
})

console.log(`Convite criado: ${code}`)
console.log(`Link de registro: /?code=${code}`)
console.log(`Validade: ${days} dias (até ${expiresAt.toDate().toISOString()})`)
