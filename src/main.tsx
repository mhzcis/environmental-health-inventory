import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { RootProviders } from './RootProviders';
import './index.css';
import { installGlobalErrorRouting } from './services/globalErrorRouting';
import { beginServiceWorkerHealth, trackServiceWorkerRegistration } from './services/serviceWorkerHealth';

installGlobalErrorRouting(window);

beginServiceWorkerHealth('serviceWorker' in navigator ? navigator.serviceWorker : null);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const env = (import.meta.env || {}) as Record<string, string | undefined>;
    const baseUrl = env.BASE_URL || './';
    const swUrl = `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}sw.js`;
    void trackServiceWorkerRegistration(
      () => navigator.serviceWorker.register(swUrl, { scope: baseUrl }),
      navigator.serviceWorker,
    );
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootProviders>
      <App />
    </RootProviders>
  </StrictMode>,
);
