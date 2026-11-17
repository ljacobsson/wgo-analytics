import { getConfig } from '../api/config';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, Check, Circle, Loader2 } from 'lucide-react';
import { AuthError, confirmForgotPassword, confirmSignUp, forgotPassword, resendCode, signIn, signUp } from './cognito';
import { Logo } from '../ui/Logo';
import { Button, Field } from '../ui/kit';
import { navigate, useRoute } from '../lib/router';
import { Landing } from './Landing';
import { cn } from '../lib/format';

type Screen = 'signin' | 'signup' | 'confirm' | 'forgot' | 'reset';

const rules = [
  { label: '8+ characters', ok: (p: string) => p.length >= 8 },
  { label: 'Uppercase letter', ok: (p: string) => /[A-Z]/.test(p) },
  { label: 'Lowercase letter', ok: (p: string) => /[a-z]/.test(p) },
  { label: 'A number', ok: (p: string) => /\d/.test(p) },
];
const strong = (p: string) => rules.every((r) => r.ok(p));

function PasswordHints({ value }: { value: string }) {
  return (
    <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
      {rules.map((r) => { const ok = r.ok(value); return (
        <li key={r.label} className={cn('flex items-center gap-1.5 text-[11.5px] transition-colors', ok ? 'text-good' : 'text-faint')}>{ok ? <Check size={12} /> : <Circle size={10} />}{r.label}</li>); })}
    </ul>
  );
}

/** The last choice of the "Keep me signed in" box, so it doesn't reset on every sign-in. */
const REMEMBER_KEY = 'wgo.remember';

const allowedDomains =() => getConfig().allowedEmailDomains ?? [];

/**
 * Signed out: `#/` is the project homepage, `#/signup` the sign-up form, anything else (incl. deep links) sign-in.
 * Nothing links to the sign-up form: people get its address from whoever runs the install (see docs/Docs.tsx).
 */
export function AuthScreens() {
  const seg0 = useRoute().segments[0];
  if (!seg0) return <Landing />;
  return <AuthForms initial={seg0 === 'signup' ? 'signup' : 'signin'} />;
}

function AuthForms({ initial }: { initial: 'signin' | 'signup' }) {
  const [screen, setScreen] = useState<Screen>(initial);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(() => localStorage.getItem(REMEMBER_KEY) !== '0');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const go = (s: Screen) => {
    setScreen(s); setErr(null); setInfo(null); setCode('');
    if ((s === 'signin' || s === 'signup') && s !== initial) navigate('/' + s);
  };
  // Follow the header links and browser back/forward between #/signin and #/signup.
  useEffect(() => { setScreen((s) => (s === 'signin' || s === 'signup' ? initial : s)); }, [initial]);

  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null); setInfo(null);
    try { await fn(); } catch (x) {
      if (x instanceof AuthError && x.code === 'UserNotConfirmedException') { go('confirm'); setInfo('Your account is not confirmed yet. Enter the code we emailed you.'); }
      else setErr((x as Error).message);
    } finally { setBusy(false); }
  };

  const emailField = <Field label="Email"><input className="field !py-2.5" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></Field>;
  const pwField = (label: string, auto: string) => <Field label={label}><input className="field !py-2.5" type="password" autoComplete={auto} required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></Field>;
  const codeField = (
    <Field label="6-digit code"><input className="field !py-3 text-center font-mono text-[22px] tracking-[.5em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="······" /></Field>
  );
  const submit = (label: string, disabled = false) => <Button variant="primary" className="w-full !py-2.5" disabled={busy || disabled}>{busy && <Loader2 size={15} className="animate-spin" />}{label}</Button>;
  const link = (label: string, to: Screen) => <button type="button" onClick={() => go(to)} className="text-accent hover:underline cursor-pointer">{label}</button>;

  let content: ReactNode, title: string, sub: string;
  if (screen === 'signin') {
    title = 'Welcome back'; sub = 'Sign in to WGO: what\'s going on?';
    content = (<form onSubmit={run(async () => { localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0'); await signIn(email, password, remember); })} className="space-y-4">{emailField}{pwField('Password', 'current-password')}
      <div className="flex items-center justify-between text-[12.5px]">
        <label className="inline-flex cursor-pointer select-none items-center gap-2 text-muted"><input type="checkbox" className="size-3.5 cursor-pointer accent-accent" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Keep me signed in</label>
        {link('Forgot password?', 'forgot')}</div>{submit('Sign in')}</form>);
  } else if (screen === 'signup') {
    title = 'Create your account'; sub = allowedDomains().length ? `Use your ${allowedDomains().map((d) => '@' + d.replace(/^\*\./, '…')).join(' or ')} email address.` : 'Start tracking in under two minutes.';
    content = (<form onSubmit={run(async () => { await signUp(email, password); go('confirm'); setInfo(`We emailed a code to ${email}.`); })} className="space-y-4">{emailField}
      <div>{pwField('Password', 'new-password')}<PasswordHints value={password} /></div>{submit('Create account', !strong(password))}
      <p className="text-center text-[13px] text-muted">Already have an account? {link('Sign in', 'signin')}</p></form>);
  } else if (screen === 'confirm') {
    title = 'Check your email'; sub = `Enter the 6-digit code sent to ${email || 'your email'}.`;
    content = (<form onSubmit={run(async () => { await confirmSignUp(email, code); go('signin'); setInfo('Account confirmed. Sign in to continue.'); })} className="space-y-4">
      {!email && emailField}{codeField}{submit('Confirm', code.length !== 6)}
      <p className="text-center text-[13px] text-muted">Did not get it? <button type="button" className="text-accent hover:underline cursor-pointer" onClick={async () => { try { await resendCode(email); setInfo('A new code is on its way.'); setErr(null); } catch (x) { setErr((x as Error).message); } }}>Resend code</button></p></form>);
  } else if (screen === 'forgot') {
    title = 'Reset your password'; sub = 'We will email you a code to set a new one.';
    content = (<form onSubmit={run(async () => { await forgotPassword(email); go('reset'); setInfo(`We emailed a code to ${email}.`); })} className="space-y-4">{emailField}{submit('Send code')}
      <p className="text-center text-[13px]">{link('Back to sign in', 'signin')}</p></form>);
  } else {
    title = 'Choose a new password'; sub = `Enter the code sent to ${email} and your new password.`;
    content = (<form onSubmit={run(async () => { await confirmForgotPassword(email, code, password); go('signin'); setInfo('Password updated. Sign in with your new password.'); setPassword(''); })} className="space-y-4">
      {codeField}<div>{pwField('New password', 'new-password')}<PasswordHints value={password} /></div>{submit('Update password', code.length !== 6 || !strong(password))}</form>);
  }

  return (
    <div className="bg-atmos flex h-full flex-col overflow-y-auto">
      <header className="mx-auto flex h-16 w-full max-w-[1200px] shrink-0 items-center px-6">
        <a href="#/" aria-label="WGO home"><Logo size={28} /></a>
      </header>
      <div className="flex flex-1 items-start justify-center px-6 pb-16 pt-[8vh]">
        <div key={screen} className="anim-pop glass w-full max-w-[420px] p-8">
          {(screen === 'confirm' || screen === 'reset' || screen === 'forgot') && <button onClick={() => go('signin')} className="mb-5 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg cursor-pointer"><ArrowLeft size={14} />Back</button>}
          <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
          <p className="mb-7 mt-1.5 text-[14px] text-muted">{sub}</p>
          {info && <div className="mb-4 rounded-lg border border-good/30 bg-good/10 px-3 py-2 text-[13px] text-good">{info}</div>}
          {err && <div className="mb-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad" role="alert">{err}</div>}
          {content}
        </div>
      </div>
    </div>
  );
}
