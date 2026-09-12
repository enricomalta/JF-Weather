"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut, updatePassword, updateProfile, User } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { clientAuth, clientDb, googleProvider } from "@/lib/firebase-client";
import { AuthenticatedShell } from "@/components/auth/authenticated-shell";

const passwordRule = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;

type Props = { children: React.ReactNode };

async function establishSession(user: User) {
  const idToken = await user.getIdToken(true);
  const response = await fetch("/api/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
  if (!response.ok) throw new Error("SESSION_FAILED");
}

export function AuthGate({ children }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const pathname = usePathname();
  const router = useRouter();
  const mode: "login" | "register" = pathname === "/register" ? "register" : "login";
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [code, setCode] = useState<string | null>(null);
  const [inviteState, setInviteState] = useState<"checking" | "valid" | "invalid" | "missing">("checking");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => onAuthStateChanged(clientAuth, (next) => { setUser(next); setChecking(false); }), []);
  useEffect(() => {
    let active = true;
    const value = new URLSearchParams(window.location.search).get("code")?.trim() || null;
    setCode(value);
    setInviteState("checking");
    setError("");

    if (!value) {
      setInviteState("missing");
      if (pathname === "/register") router.replace("/login");
      return () => { active = false; };
    }

    fetch(`/api/auth/invite?code=${encodeURIComponent(value)}`, { cache: "no-store" }).then(async (response) => {
      const result = await response.json().catch(() => ({ valid: false }));
      if (!active) return;
      if (result.valid === true) {
        setInviteState("valid");
      } else {
        setInviteState("invalid");
        if (pathname === "/register") router.replace("/login");
      }
    }).catch(() => {
      if (!active) return;
      setInviteState("invalid");
      if (pathname === "/register") router.replace("/login");
    });

    return () => { active = false; };
  }, [pathname, router]);

  const title = useMemo(() => mode === "login" ? "Acesse o JF Radar" : "Crie seu acesso", [mode]);
  const closeInviteMessage = () => {
    window.history.replaceState({}, "", window.location.pathname);
    setCode(null);
    setInviteState("missing");
    router.replace("/login");
    setError("");
  };
  if (checking || (mode === "register" && inviteState === "checking")) return <div className="auth-loading" role="status" aria-live="polite"><div className="auth-loading-mark"><span className="auth-loading-ring auth-loading-ring-back" /><span className="auth-loading-ring auth-loading-ring-front" /><img src="/icon.svg" alt="JF Radar" /><i /></div><p>{mode === "register" ? "VALIDANDO CONVITE" : "CARREGANDO ACESSO"}</p></div>;
  if (user) return <AuthenticatedShell user={user}>{children}</AuthenticatedShell>;
  if (mode === "register" && inviteState !== "valid") return null;

  async function loginWithEmail(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try { const credential = await signInWithEmailAndPassword(clientAuth, form.email, form.password); await establishSession(credential.user); }
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
      const idToken = await credential.user.getIdToken(true);
      const response = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, code, name: form.name, newUser: true }) });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (result.error === "INVITE_INVALID") throw new Error("INVITE_INVALID");
        throw new Error("REGISTER_FAILED");
      }
      await establishSession(credential.user);
    } catch (cause) { setError(cause instanceof Error && cause.message === "INVITE_INVALID" ? "Este convite já foi usado, expirou ou é inválido." : "Não foi possível concluir o cadastro."); } finally { setBusy(false); }
  }

  async function googleLogin() {
    setError("");
    if (mode === "register" && inviteState !== "valid") { setError("É necessário um convite válido para criar uma conta."); return; }
    setBusy(true);
    try {
      const result = await signInWithPopup(clientAuth, googleProvider);
      if (mode === "register") {
        const idToken = await result.user.getIdToken(true);
        const response = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, code, name: result.user.displayName || "", newUser: result.additionalUserInfo?.isNewUser === true }) });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          if (data.error === "INVITE_INVALID") throw new Error("INVITE_INVALID");
          throw new Error("REGISTER_FAILED");
        }
        await establishSession(result.user);
      } else {
        await setDoc(doc(clientDb, "users", result.user.uid), { name: result.user.displayName, email: result.user.email, photoURL: result.user.photoURL, createdAt: serverTimestamp() }, { merge: true });
        await establishSession(result.user);
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message === "INVITE_INVALID") {
        setError("Este convite já foi usado, expirou ou é inválido.");
        if (mode === "register") router.replace("/login");
      } else setError("Não foi possível conectar com o Google.");
    } finally { setBusy(false); }
  }

  const invalidInvite = mode === "register" && inviteState !== "valid";
  return <main className="auth-shell"><div className="auth-grid" aria-hidden="true" /><section className="auth-card"><div className="auth-logo-wrap"><img className="auth-logo" src="/icon.svg" alt="JF Radar" /></div><div className="auth-brand">JF <span>RADAR</span></div><p className="auth-kicker">MONITORAMENTO METEOROLÓGICO</p><h1>{title}</h1><p className="auth-muted">Previsão e radar em tempo real para Juiz de Fora.</p>
    {mode === "login" ? <form onSubmit={loginWithEmail} className="auth-form"><label>Email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Senha<input type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label><button className="auth-primary" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button></form> : <form onSubmit={register} className="auth-form"><label>Nome<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Senha<input type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label><label>Repetir senha<input type="password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} /></label><p className="auth-hint">Mínimo de 8 caracteres, com maiúscula, minúscula, número e símbolo.</p><button className="auth-primary" disabled={busy || invalidInvite}>{busy ? "Criando…" : "Criar conta"}</button></form>}
    <button className="auth-google" onClick={googleLogin} disabled={busy}><span className="google-mark" aria-hidden="true">G</span><span>Continuar com Google</span></button>{error && <p className="auth-error" role="alert">{error}</p>}
    {mode === "register" && <button className="auth-link" onClick={closeInviteMessage}>Voltar para login</button>}
    {mode === "login" && code && inviteState === "invalid" && <div className="auth-dialog"><strong>Código expirado ou inválido</strong><span>Este link de convite não permite criar uma conta.</span><button onClick={closeInviteMessage}>Fechar</button></div>}
  </section></main>;
}
