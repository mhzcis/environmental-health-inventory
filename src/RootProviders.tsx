import React from 'react';
import { CacheProvider } from '@emotion/react';
import CssBaseline from '@mui/material/CssBaseline';
import { cacheRtl } from './theme/theme';
import { AppThemeProvider } from './theme/ThemeContext';
import { AppErrorBoundary } from './components/AppErrorBoundary';

/**
 * P12 RW2-01 — the error boundary is the OUTERMOST element of the root tree, above the emotion
 * cache and theme providers, so a provider failure (e.g. Web Storage access throwing inside
 * AppThemeProvider) is caught. The boundary fallback uses plain DOM + inline styles only and does
 * not depend on any of these providers or on storage.
 */
export function RootProviders({ children, onReload }: { children: React.ReactNode; onReload?: () => void }): React.ReactElement {
  return (
    <AppErrorBoundary onReload={onReload}>
      <CacheProvider value={cacheRtl}>
        <AppThemeProvider>
          <CssBaseline />
          {children}
        </AppThemeProvider>
      </CacheProvider>
    </AppErrorBoundary>
  );
}

export default RootProviders;
