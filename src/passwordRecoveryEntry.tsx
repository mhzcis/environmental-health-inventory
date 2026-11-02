import { createRoot } from 'react-dom/client';
import { RootProviders } from './RootProviders';
import PasswordRecovery from './components/PasswordRecovery';
import { createPasswordRecovery } from './services/passwordRecovery';
import './index.css';

let recovery: ReturnType<typeof createPasswordRecovery> | null = null;
try { recovery = createPasswordRecovery(); } catch { /* Fail closed if configuration or tab storage is unavailable. */ }
window.addEventListener('pagehide', () => recovery?.dispose(), { once: true });
createRoot(document.getElementById('root')!).render(<RootProviders><PasswordRecovery recovery={recovery} /></RootProviders>);
