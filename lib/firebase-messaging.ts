import { getMessaging, getToken, isSupported } from "firebase/messaging";
import { firebaseApp } from "@/lib/firebase-client";

export type PushRegistrationResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "denied" | "missing-vapid-key" | "token-unavailable" | "registration-failed" };

export async function registerPushToken(userId: string, idToken: string): Promise<PushRegistrationResult> {
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
    return { ok: false, reason: "unsupported" };
  }

  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "denied" };

  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) return { ok: false, reason: "missing-vapid-key" };

  try {
    if (!(await isSupported())) return { ok: false, reason: "unsupported" };
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(firebaseApp), { vapidKey, serviceWorkerRegistration: registration });
    if (!token) return { ok: false, reason: "token-unavailable" };
    const response = await fetch("/api/auth/push/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, idToken, fcmToken: token }),
    });
    if (!response.ok) return { ok: false, reason: "registration-failed" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "registration-failed" };
  }
}
