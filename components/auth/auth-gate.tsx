"use client";

import { useEffect, useMemo, useState } from "react";
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut, updatePassword, updateProfile, User } from "firebase/auth";
import { collection, doc, getDoc, runTransaction, serverTimestamp, setDoc } from "firebase/firestore";
import { clientAuth, clientDb, googleProvider } from "@/lib/firebase-client";
import { AuthenticatedShell } from "@/components/auth/authenticated-shell";

const passwordRule = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;

type Props = { children: React.ReactNode };

export function AuthGate({ children }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [code, setCode] = useState<string | null>(null);
  const [inviteState, setInviteState] = useState<"checking" | "valid" | "invalid" | "missing">("checking");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => onAuthStateChanged(clientAuth, (next) => { setUser(next); setChecking(false); }), []);
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("code");
    setCode(value);
    if (!value) { setInviteState("missing"); return; }
    getDoc(doc(clientDb, "inviteCodes", value)).then((snapshot) => {
      const data = snapshot.data() as { valid?: boolean; usedAt?: unknown; expiresAt?: { toMillis?: () => number } } | undefined;
      const expired = Boolean(data?.expiresAt?.toMillis && data.expiresAt.toMillis() < Date.now());
      setInviteState(snapshot.exists() && data?.valid !== false && !data?.usedAt && !expired ? "valid" : "invalid");
    }).catch(() => setInviteState("invalid"));
  }, []);

  const title = useMemo(() => mode === "login" ? "Acesse o JF Radar" : "Crie seu acesso", [mode]);
  if (checking) return <div className="auth-loading" role="status" aria-live="polite"><div className="auth-loading-mark"><img src="/icon.svg" alt="JF Radar" /><span /></div><p>CARREGANDO ACESSO</p></div>;
  if (user) return <AuthenticatedShell user={user}>{children}</AuthenticatedShell>;

  async function loginWithEmail(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try { await signInWithEmailAndPassword(clientAuth, form.email, form.password); }
    catch { setError("Email ou senha inválidos."); } finally { setBusy(false); }
  }

  async function register(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (inviteState !== "valid") return setError("É necessário um convite válido para criar uma conta.");
    if (!passwordRule.test(form.password)) return setError("A senha precisa ter 8 caracteres, maiúscula, minúscula, número e símbolo.");
    if (form.password !== form.confirm) return setError("As senhas não conferem.");
    setBusy(true);
    try {
      const credential = await createUserWithEmailAndPassword(clientAuth, form.email, form.password);
      await updateProfile(credential.user, { displayName: form.name });
      await runTransaction(clientDb, async (transaction) => {
        const inviteRef = doc(collection(clientDb, "inviteCodes"), code!);
        const invite = await transaction.get(inviteRef);
        const data = invite.data() as { valid?: boolean; usedAt?: unknown; expiresAt?: { toMillis?: () => number } } | undefined;
        if (!invite.exists() || data?.valid === false || data?.usedAt || Boolean(data?.expiresAt?.toMillis && data.expiresAt.toMillis() < Date.now())) throw new Error("INVITE_INVALID");
        transaction.set(doc(clientDb, "users", credential.user.uid), { name: form.name, email: form.email, createdAt: serverTimestamp(), notificationsEnabled: false });
        transaction.update(inviteRef, { usedAt: serverTimestamp(), usedBy: credential.user.uid });
      });
    } catch (cause) { setError(cause instanceof Error && cause.message === "INVITE_INVALID" ? "Este convite já foi usado, expirou ou é inválido." : "Não foi possível concluir o cadastro."); } finally { setBusy(false); }
  }

  async function googleLogin() { setError(""); setBusy(true); try { const result = await signInWithPopup(clientAuth, googleProvider); await setDoc(doc(clientDb, "users", result.user.uid), { name: result.user.displayName, email: result.user.email, photoURL: result.user.photoURL, createdAt: serverTimestamp() }, { merge: true }); } catch { setError("Não foi possível conectar com o Google."); } finally { setBusy(false); } }

  const invalidInvite = mode === "register" && inviteState !== "valid";
  return <main className="auth-shell"><div className="auth-grid" aria-hidden="true" /><section className="auth-card"><div className="auth-logo-wrap"><img className="auth-logo" src="/icon.svg" alt="JF Radar" /></div><div className="auth-brand">JF <span>RADAR</span></div><p className="auth-kicker">MONITORAMENTO METEOROLÓGICO</p><h1>{title}</h1><p className="auth-muted">Previsão e radar em tempo real para Juiz de Fora.</p>
    {mode === "login" ? <form onSubmit={loginWithEmail} className="auth-form"><label>Email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Senha<input type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label><button className="auth-primary" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button></form> : <form onSubmit={register} className="auth-form"><label>Nome<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Senha<input type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label><label>Repetir senha<input type="password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} /></label><p className="auth-hint">Mínimo de 8 caracteres, com maiúscula, minúscula, número e símbolo.</p><button className="auth-primary" disabled={busy || invalidInvite}>{busy ? "Criando…" : "Criar conta"}</button></form>}
    <button className="auth-google" onClick={googleLogin} disabled={busy}>Continuar com Google</button>{error && <p className="auth-error" role="alert">{error}</p>}
    {mode === "login" ? <button className="auth-link" onClick={() => { setMode("register"); setError(""); }}>{code ? "Usar meu convite para criar conta" : "Tenho um convite"}</button> : <button className="auth-link" onClick={() => setMode("login")}>Voltar para login</button>}
    {mode === "register" && inviteState !== "valid" && <div className="auth-dialog"><strong>{inviteState === "missing" ? "Convite necessário" : "Código expirado ou inválido"}</strong><span>O cadastro só pode ser acessado por um link de convite válido.</span><button onClick={() => setMode("login")}>Fechar</button></div>}
  </section></main>;
}
