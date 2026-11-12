/**
 * R8-AUTH-01: tell "the server could not be reached" apart from "the server said no".
 * Only a transport-level failure (offline, DNS, fetch/TypeError, timeout, reset) is `unavailable`; an HTTP/Postgres
 * answer (401/403/42501/PGRST…, disabled or missing profile) is a real decision and keeps failing closed.
 * Never logs or returns tokens.
 */
const NETWORK_PATTERNS = [
  'failed to fetch', 'fetch failed', 'networkerror', 'network error', 'network request failed', 'load failed',
  'timeout', 'timed out', 'etimedout', 'econnreset', 'econnrefused', 'enotfound', 'eai_again', 'offline',
  'err_internet_disconnected', 'err_name_not_resolved', 'err_network_changed', 'the internet connection appears to be offline',
];

export const isBrowserOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

export const isAuthNetworkUnavailable = (error: unknown): boolean => {
  if (isBrowserOffline()) return true;
  if (!error) return false;
  const record = (typeof error === 'object' ? error : {}) as { name?: unknown; message?: unknown; status?: unknown; code?: unknown; details?: unknown };
  const status = Number(record.status);
  if (Number.isFinite(status) && status >= 400) return false; // the server answered
  if (typeof record.code === 'string' && /^(42|22|23|28|PGRST|P0)/.test(record.code)) return false;
  const text = `${String(record.name || '')} ${String(record.message || (typeof error === 'string' ? error : ''))} ${String(record.details || '')}`.toLowerCase();
  if (record.name === 'AbortError' || record.name === 'TimeoutError') return true;
  if (record.name === 'TypeError' && text.includes('fetch')) return true;
  return NETWORK_PATTERNS.some(pattern => text.includes(pattern));
};

export const NETWORK_UNAVAILABLE_PREFIX = 'NETWORK_UNAVAILABLE:';
export const isNetworkUnavailableMessage = (message: string | undefined | null): boolean =>
  typeof message === 'string' && message.startsWith(NETWORK_UNAVAILABLE_PREFIX);
