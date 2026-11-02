import { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, CircularProgress, IconButton, InputAdornment, TextField, Typography } from '@mui/material';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import { createPasswordRecovery, passwordRecoveryMessage } from '../services/passwordRecovery';
import { applicationUrl } from '../services/supabaseConfig';

type Recovery = ReturnType<typeof createPasswordRecovery>;
export default function PasswordRecovery({ recovery }: { recovery: Recovery | null }) {
  const [state, setState] = useState<'checking' | 'ready' | 'invalid' | 'complete'>('checking');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signedOut, setSignedOut] = useState(true);
  const loginUrl = applicationUrl(window.location.href);

  useEffect(() => {
    let active = true;
    if (!recovery) { setState('invalid'); setError('خدمة الاستعادة غير مهيأة. تواصل مع مدير النظام.'); return; }
    recovery.initialize().then(() => { if (active) setState('ready'); }).catch(err => {
      if (active) { setError(passwordRecoveryMessage(err)); setState('invalid'); }
    });
    return () => { active = false; };
  }, [recovery]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!recovery || busy || state !== 'ready') return;
    setError('');
    if (password.length < 8 || password.length > 128) { setError('يجب أن تتكون كلمة المرور من 8 إلى 128 حرفًا.'); return; }
    if (password !== confirmation) { setError('كلمتا المرور غير متطابقتين.'); return; }
    setBusy(true);
    try {
      const result = await recovery.update(password);
      setSignedOut(result.signedOut);
      setPassword(''); setConfirmation(''); setShowPassword(false); setShowConfirmation(false);
      setState('complete');
    } catch (err) { setError(passwordRecoveryMessage(err)); }
    finally { setBusy(false); }
  };

  return <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2, direction: 'rtl', bgcolor: '#f8fafc' }}>
    <Card sx={{ width: '100%', maxWidth: 480, borderRadius: 4 }}><CardContent sx={{ p: 4 }}>
      <Typography component="h1" variant="h5" sx={{ fontWeight: 'bold', mb: 2 }}>تعيين كلمة مرور جديدة</Typography>
      {state === 'checking' && <><CircularProgress aria-label="التحقق من رابط الاستعادة" /><Typography sx={{ mt: 2 }}>جارٍ التحقق من رابط الاستعادة.</Typography></>}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {state === 'invalid' && <Button href={loginUrl} variant="contained">العودة لطلب رابط استعادة جديد</Button>}
      {state === 'ready' && <Box component="form" onSubmit={submit} autoComplete="off">
        <Typography sx={{ mb: 2, color: 'text.secondary' }}>تُستخدم كلمة المرور الجديدة لتسجيل دخول حسابك إلى النظام.</Typography>
        <TextField fullWidth required disabled={busy} label="كلمة المرور الجديدة" autoComplete="new-password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} helperText="من 8 إلى 128 حرفًا." sx={{ mb: 2 }} slotProps={{ htmlInput: { minLength: 8, maxLength: 128 }, input: { endAdornment: <InputAdornment position="end"><IconButton type="button" disabled={busy} aria-label={showPassword ? 'إخفاء كلمة المرور الجديدة' : 'إظهار كلمة المرور الجديدة'} onClick={() => setShowPassword(value => !value)} onMouseDown={event => event.preventDefault()}>{showPassword ? <VisibilityOff /> : <Visibility />}</IconButton></InputAdornment> } }} />
        <TextField fullWidth required disabled={busy} label="تأكيد كلمة المرور" autoComplete="new-password" type={showConfirmation ? 'text' : 'password'} value={confirmation} onChange={event => setConfirmation(event.target.value)} error={confirmation.length > 0 && confirmation !== password} sx={{ mb: 3 }} slotProps={{ htmlInput: { minLength: 8, maxLength: 128 }, input: { endAdornment: <InputAdornment position="end"><IconButton type="button" disabled={busy} aria-label={showConfirmation ? 'إخفاء تأكيد كلمة المرور' : 'إظهار تأكيد كلمة المرور'} onClick={() => setShowConfirmation(value => !value)} onMouseDown={event => event.preventDefault()}>{showConfirmation ? <VisibilityOff /> : <Visibility />}</IconButton></InputAdornment> } }} />
        <Button type="submit" fullWidth variant="contained" disabled={busy}>{busy ? 'جارٍ الحفظ...' : 'حفظ كلمة المرور الجديدة'}</Button>
      </Box>}
      {state === 'complete' && <><Alert severity={signedOut ? 'success' : 'warning'} sx={{ mb: 2 }}>{signedOut ? 'تم تغيير كلمة المرور وإنهاء جلسة الاستعادة. سجّل الدخول بكلمة المرور الجديدة.' : 'تم تغيير كلمة المرور، لكن تعذر إنهاء جلسة الاستعادة. أغلق هذه الصفحة وسجّل الدخول من صفحة التطبيق.'}</Alert><Button href={loginUrl} variant="contained">الانتقال إلى تسجيل الدخول</Button></>}
    </CardContent></Card>
  </Box>;
}
