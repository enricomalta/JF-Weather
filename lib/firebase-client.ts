import { getApp, getApps, initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const runtimeConfig = { ...firebaseConfig, apiKey: firebaseConfig.apiKey || "build-only-api-key" };
export const firebaseApp = getApps().length ? getApp() : initializeApp(runtimeConfig);
export const clientDb = getFirestore(firebaseApp);
export const clientAuth = (typeof window === "undefined" ? null : getAuth(firebaseApp)) as Auth;
export const googleProvider = new GoogleAuthProvider();
export const firebaseProjectId = firebaseConfig.projectId;
