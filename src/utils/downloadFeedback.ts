/**
 * LF-3: browser download / save / share sheets do not reliably report user
 * cancellation for programmatic triggers (jspdf `pdf.save`, file-saver `saveAs`,
 * XLSX.writeFile, or `<a download>`). Claiming «تم التنزيل» after those calls is
 * therefore inaccurate when the user cancels.
 *
 * Use these helpers for success toasts that follow a prepared file hand-off.
 * If a future path uses `showSaveFilePicker` (or another API that throws
 * `AbortError` on cancel), catch that with `isDownloadAbortError` and skip the
 * success toast entirely.
 */

export const DOWNLOAD_PREPARED_MESSAGE = 'تم تجهيز الملف للتنزيل';

/** Short success toast after a download/export hand-off that cannot detect cancel. */
export function downloadPreparedMessage(detail?: string): string {
  const trimmed = typeof detail === 'string' ? detail.trim() : '';
  return trimmed ? `${DOWNLOAD_PREPARED_MESSAGE}: ${trimmed}` : DOWNLOAD_PREPARED_MESSAGE;
}

/** True when an error is a user-cancelled file picker / share abort. */
export function isDownloadAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError') return true;
  const message = String((error as { message?: unknown }).message || '');
  return /aborted|AbortError|user.?cancel|The user aborted/i.test(message);
}
