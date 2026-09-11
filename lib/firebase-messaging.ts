import { getMessaging, getToken, isSupported } from "firebase/messaging";
import { doc, setDoc } from "firebase/firestore";
import { clientDb, firebaseApp } from "@/lib/firebase-client";

export async function registerPushToken(userId: string) {
  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey || !(await isSupported())) return false;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;
  const token = await getToken(getMessaging(firebaseApp), { vapidKey, serviceWorkerRegistration: await navigator.serviceWorker.ready });
  if (!token) return false;
  await setDoc(doc(clientDb, "users", userId), { fcmTokens: { [token]: true }, notificationsEnabled: true }, { merge: true });
  return true;
}
