"use client";

import { useEffect, useState } from "react";
import { signOut, updatePassword, type User } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { Copy, MessageCircle, ShieldPlus, X } from "lucide-react";
import { clientAuth, clientDb } from "@/lib/firebase-client";
import { registerPushToken } from "@/lib/firebase-messaging";

export function AuthenticatedShell({ user, children }: { user: User; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "profile" | "settings">("menu");
  const [notifications, setNotifications] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const initials = (user.displayName || user.email || "U").slice(0, 1).toUpperCase();

  useEffect(() => {
    getDoc(doc(clientDb, "users", user.uid)).then((snapshot) => {
      const data = snapshot.data();
      setAdmin(data?.admin === true);
      setNotifications(data?.notificationsEnabled === true);
    }).catch(() => undefined);
  }, [user.uid]);

  async function toggleNotifications() {
    if (!notifications) {
      const registered = await registerPushToken(user.uid);
      if (!registered) { setNotice("Permita as notificações no navegador para ativá-las."); return; }
    }
    const next = !notifications;
    setNotifications(next);
    await setDoc(doc(clientDb, "users", user.uid), { notificationsEnabled: next }, { merge: true });
  }

  async function createInvite() {
    setInviteBusy(true); setNotice("");
    try {
      const idToken = await user.getIdToken(true);
      const response = await fetch("/api/auth/invite/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setInviteLink(`${window.location.origin}/register?code=${result.code}`);
    } catch { setNotice("Não foi possível gerar o convite."); } finally { setInviteBusy(false); }
  }

  async function copyInvite() { await navigator.clipboard.writeText(inviteLink); setNotice("Link copiado."); }
  function whatsappInvite() { window.open(`https://wa.me/?text=${encodeURIComponent(`Entre no JF Radar: ${inviteLink}`)}`, "_blank", "noopener,noreferrer"); }

  return <div className="authenticated-shell"><div className="profile-area"><button type="button" className="profile-trigger" onClick={() => { setOpen((value) => !value); setView("menu"); }} aria-label="Abrir menu do perfil" aria-expanded={open} aria-haspopup="menu">{user.photoURL ? <img src={user.photoURL} alt="Foto do perfil" /> : initials}</button>
    {open && <aside className="profile-menu" role="menu">{view === "menu" && <><strong>{user.displayName || user.email}</strong><button role="menuitem" onClick={() => setView("profile")}>Perfil</button><button role="menuitem" onClick={() => setView("settings")}>Configurações</button>{admin && <button role="menuitem" onClick={() => { setInviteOpen(true); setOpen(false); void createInvite(); }}><ShieldPlus size={16} /> Convites</button>}<button role="menuitem" onClick={() => signOut(clientAuth)}>Sair</button></>}
    {view === "profile" && <><button type="button" onClick={() => setView("menu")}>Voltar</button><strong>Seu perfil</strong><span>{user.email}</span><span>Cadastro: {user.metadata.creationTime ? new Date(user.metadata.creationTime).toLocaleDateString("pt-BR") : "—"}</span>{user.providerData.some((provider) => provider.providerId === "password") && <><input type="password" placeholder="Nova senha" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /><button type="button" onClick={async () => { if (newPassword.length >= 8) { await updatePassword(user, newPassword); setNewPassword(""); } }}>Trocar senha</button></>}</>}
    {view === "settings" && <><button type="button" onClick={() => setView("menu")}>Voltar</button><strong>Configurações</strong><label className="settings-toggle"><input type="checkbox" checked={notifications} onChange={toggleNotifications} /> Ativar notificações</label><span>Localização: indisponível por enquanto</span>{notice && <span role="alert">{notice}</span>}</>}</aside>}
  </div><div className="authenticated-content">{children}</div>{inviteOpen && <div className="auth-dialog" role="dialog" aria-modal="true"><button type="button" className="dialog-close" aria-label="Fechar" onClick={() => setInviteOpen(false)}><X size={18} /></button><strong>Gerar convite</strong>{inviteLink ? <><input readOnly value={inviteLink} aria-label="Link do convite" /><div className="invite-actions"><button type="button" onClick={copyInvite}><Copy size={16} /> Copiar link</button><button type="button" onClick={whatsappInvite}><MessageCircle size={16} /> WhatsApp</button></div></> : <button type="button" onClick={createInvite} disabled={inviteBusy}>{inviteBusy ? "Gerando…" : "Gerar convite"}</button>}{notice && <span role="alert">{notice}</span>}</div>}</div>;
}
