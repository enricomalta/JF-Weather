"use client";

import { useState } from "react";
import { signOut, updatePassword, type User } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { clientAuth, clientDb } from "@/lib/firebase-client";
import { registerPushToken } from "@/lib/firebase-messaging";

export function AuthenticatedShell({ user, children }: { user: User; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "profile" | "settings">("menu");
  const [notifications, setNotifications] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const initials = (user.displayName || user.email || "U").slice(0, 1).toUpperCase();
  async function toggleNotifications() {
    if (!notifications) {
      const registered = await registerPushToken(user.uid);
      if (!registered) return;
    }
    const next = !notifications;
    setNotifications(next);
    await setDoc(doc(clientDb, "users", user.uid), { notificationsEnabled: next }, { merge: true });
  }
  return <div className="authenticated-shell"><button className="profile-trigger" onClick={() => { setOpen(!open); setView("menu"); }} aria-label="Abrir menu do perfil">{user.photoURL ? <img src={user.photoURL} alt="Foto do perfil" /> : initials}</button>{open && <aside className="profile-menu">{view === "menu" && <><strong>{user.displayName || user.email}</strong><button onClick={() => setView("profile")}>Perfil</button><button onClick={() => setView("settings")}>Configurações</button><button onClick={() => signOut(clientAuth)}>Sair</button></>}{view === "profile" && <><button onClick={() => setView("menu")}>Voltar</button><strong>Seu perfil</strong><span>{user.email}</span><span>Cadastro: {user.metadata.creationTime ? new Date(user.metadata.creationTime).toLocaleDateString("pt-BR") : "—"}</span>{user.providerData.some((provider) => provider.providerId === "password") && <><input type="password" placeholder="Nova senha" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /><button onClick={async () => { if (newPassword.length >= 8) { await updatePassword(user, newPassword); setNewPassword(""); } }}>Trocar senha</button></>}</>}{view === "settings" && <><button onClick={() => setView("menu")}>Voltar</button><strong>Configurações</strong><label className="settings-toggle"><input type="checkbox" checked={notifications} onChange={toggleNotifications} /> Ativar notificações</label><span>Localização: indisponível por enquanto</span></>}</aside>}<div>{children}</div></div>;
}
