// @vitest-environment jsdom
// R8 FIX ROUND 1 — R2-R8-02 / RT-R8-01: the dashboard reads server-confirmed data only and excludes archived items'
// movements from its activity counters and recent list.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { localDateString } from '../src/utils/localDate';
const fake = vi.hoisted(() => ({ materials: [] as any[], confirmed: [] as any[], working: [] as any[] }));
vi.mock('../src/services/dataService', () => ({ dataService: {
  getSettings: () => ({ organizationName: 'QA', departmentName: 'QA', categories: [{ name: 'QA' }], units: ['قطعة'], storehouses: ['QA-A'], expiryWarningThresholdDays: 30 }),
  getMaterials: () => fake.materials, getConfirmedTransactions: () => fake.confirmed,
  getTransactions: () => fake.working, subscribe: () => () => {}, hasPermission: () => true,
} }));
vi.mock('../src/context/StorehouseContext', () => ({ useStorehouse: () => ({ selectedStorehouse: 'all', setSelectedStorehouse: () => {}, activeStorehouses: ['QA-A'] }) }));
vi.mock('recharts', () => {
  const Box = ({ children }: any) => <div>{children}</div>;
  return { ResponsiveContainer: Box, PieChart: Box, Pie: Box, Cell: () => null, BarChart: Box, Bar: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, Legend: () => null };
});
import Dashboard from '../src/pages/Dashboard';
afterEach(() => cleanup());

it('R1-R2-02-dash archived movements and unconfirmed (working-only) movements are not counted or listed', () => {
  const today = localDateString();
  const mat = (id: string, code: string, extra: any = {}) => ({ id, code, name: 'QA ' + code, category: 'QA', unit: 'قطعة', minimumStock: 0, currentStock: 3, warehouseStocks: { 'QA-A': 3 }, storageLocation: 'QA-A', initialStock: 0, ...extra });
  const tx = (id: string, itemId: string, code: string) => ({ id, itemId, itemCode: code, itemName: 'QA ' + code, transactionType: 'وارد', quantity: 3, date: today, transactionNumber: 'W-' + id, storehouse: 'QA-A', storehouseId: 'qa-a', createdAt: `${today}T08:00:00Z`, executedBy: 'QA' });
  fake.materials = [mat('m-active', 'PES-1003'), mat('m-arch', 'PES-1002', { lifecycleStatus: 'archived', currentStock: 0, warehouseStocks: { 'QA-A': 0 } })];
  fake.confirmed = [tx('t1', 'm-active', 'PES-1003'), tx('t2', 'm-arch', 'PES-1002')];
  fake.working = [...fake.confirmed, tx('t3-pending', 'm-active', 'PES-1003')];
  render(<MemoryRouter><Dashboard /></MemoryRouter>);
  expect(screen.getByText(/حركات اليوم المسجلة/).textContent).toContain('1 حركة');
  expect(document.body.textContent).not.toContain('QA PES-1002');
  expect(document.body.textContent).not.toContain('W-t3-pending');
});
