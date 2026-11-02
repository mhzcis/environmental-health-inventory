import config from '../../supabase-config.json';

const env = (import.meta.env || {}) as Record<string, string | undefined>;
const saved = config as Record<string, string>;
export const supabaseUrl = env.VITE_SUPABASE_URL || saved.url || saved.supabaseUrl;
export const supabasePublicKey = env.VITE_SUPABASE_ANON_KEY || saved.anonKey || saved.supabaseAnonKey;
export const isSupabaseConfigured = (): boolean => Boolean(supabaseUrl && supabasePublicKey);
// Both entry pages live beside index.html; resolve against the actual hosting folder.
export const applicationUrl = (href: string): string => new URL('./', href).href;
export const passwordRecoveryUrl = (href: string): string => new URL('reset-password.html', applicationUrl(href)).href;
