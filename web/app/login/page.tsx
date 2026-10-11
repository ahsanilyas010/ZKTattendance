'use client';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
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
      <form onSubmit={submit} className="card pad" style={{ width: 360, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="brand" style={{ padding: 0 }}>
          <div className="logo">A</div><strong>Attendance</strong>
        </div>
        <label className="field">Email<input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
        <label className="field">Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        {error && <div className="notice err" role="alert">{error}</div>}
        <button className="btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
