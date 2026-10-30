import { HashRouter, Routes, Route } from 'react-router-dom';
import AppLayout from '../layouts/AppLayout';
import Dashboard from '../pages/Dashboard';
import Materials from '../pages/Materials';
import Transactions from '../pages/Transactions';
import GeneratorLog from '../pages/GeneratorLog';
import Reports from '../pages/Reports';
import AuditLogs from '../pages/AuditLogs';
import Settings from '../pages/Settings';

export default function AppRouter() {
  return (
    <HashRouter>
      <AppLayout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/materials" element={<Materials />} />
          <Route path="/pesticides" element={<Materials />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/generator-log" element={<GeneratorLog />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/audit" element={<AuditLogs />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </AppLayout>
    </HashRouter>
  );
}

