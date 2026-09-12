import { getMessaging, getToken, isSupported } from "firebase/messaging";
import { doc, setDoc } from "firebase/firestore";
import { clientDb, firebaseApp } from "@/lib/firebase-client";

export async function registerPushToken(userId: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return false;
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return false;
  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey || !(await isSupported())) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(firebaseApp), { vapidKey, serviceWorkerRegistration: registration });
    if (!token) return false;
    await setDoc(doc(clientDb, "users", userId), { fcmTokens: { [token]: true }, notificationsEnabled: true }, { merge: true });
    return true;
  } catch {
    return false;
  }
}
