'use client';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';

export default function Login() {
  const [mode, setMode] = useState<'key' | 'email'>('key');
  const [accessKey, setAccessKey] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await fetch('/api/access/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: accessKey }) }).catch(() => null);
    if (res?.ok) { window.location.href = '/'; return; }
    const body = await res?.json().catch(() => ({}));
    setError(body?.error ?? 'Could not reach the server. Try again.');
    setBusy(false);
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { data, error } = await supabaseBrowser().auth.signInWithPassword({ email, password });
    if (error) { setError('Email or password is not right.'); setBusy(false); return; }
    if (data.user?.app_metadata?.role !== 'admin') {
      await supabaseBrowser().auth.signOut();
      setError('This account is not an administrator. See the setup guide to grant access.');
      setBusy(false);
      return;
    }
    window.location.href = '/';
  }

  return (
    <div className="center">
      <form onSubmit={mode === 'key' ? submitKey : submitEmail} className="card pad" style={{ width: 360, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="brand" style={{ padding: 0 }}>
          <div className="logo">A</div><strong>Attendance</strong>
        </div>
        {mode === 'key' ? (
          <label className="field">Access key
            <input type="password" required autoFocus value={accessKey} onChange={(e) => setAccessKey(e.target.value)} autoComplete="current-password" name="password" />
            <span className="hint">Enter it once. This browser stays signed in for 90 days.</span>
          </label>
        ) : (
          <>
            <label className="field">Email<input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
            <label className="field">Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
          </>
        )}
        {error && <div className="notice err" role="alert">{error}</div>}
        <button className="btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <button type="button" className="btn ghost small" onClick={() => { setMode(mode === 'key' ? 'email' : 'key'); setError(''); }}>
          {mode === 'key' ? 'Use email and password instead' : 'Use the access key instead'}
        </button>
      </form>
    </div>
  );
}
