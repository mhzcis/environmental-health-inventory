// @vitest-environment jsdom
// QA 2026-11-06 TAB-04 / TAB-05: search from a later page and bulk selection scope.
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
const mats=Array.from({length:23},(_,i)=>({id:`qa-${i}`,code:`QA-${1000+i}`,name:`QA item ${i}`,category:'QA',unit:'قطعة',initialStock:0,currentStock:5,minimumStock:0,warehouseStocks:{'QA-A':5},storageLocation:'QA-A'}));
vi.mock('../src/context/StorehouseContext',()=>({useStorehouse:()=>({selectedStorehouse:'QA-A'})}));
vi.mock('../src/services/dataService',()=>({dataService:{getSettings:()=>({organizationName:'QA',departmentName:'QA',categories:[{name:'QA',prefix:'QA'}],units:['قطعة'],storehouses:['QA-A'],expiryWarningThresholdDays:30}),getMaterials:()=>mats,getTransactions:()=>[],getCurrentUser:()=>({fullName:'QA'}),subscribe:()=>()=>{},generateItemCode:()=>'QA-9999',hasPermission:()=>true,saveTransactionBatch:vi.fn(),deleteMaterial:vi.fn()}}));
import Materials from '../src/pages/Materials';
afterEach(()=>cleanup());
const search=()=>screen.getByPlaceholderText('ابحث بالاسم، الكود (بما فيه أرقام فقط)...');
it('TAB-04 searching while on page 3 shows the match on page 1', ()=>{
  render(<MemoryRouter><Materials/></MemoryRouter>);
  const next=screen.getByRole('button',{name:/next page|الصفحة التالية/i}); fireEvent.click(next); fireEvent.click(next);
  expect(screen.getByText(/^21-23 من 23$/)).toBeTruthy();
  fireEvent.change(search(),{target:{value:'QA-1003'}});
  expect(screen.getByText(/^1-1 من 1$/)).toBeTruthy();
  expect(screen.getAllByText('QA-1003').length).toBeGreaterThan(0);
});
it('TAB-05 narrowing the filter clears the bulk selection (no hidden rows in a bulk delete)', ()=>{
  render(<MemoryRouter><Materials/></MemoryRouter>);
  fireEvent.change(search(),{target:{value:'QA item 1'}});
  const rows=screen.getAllByRole('row').filter(r=>/QA-1001|QA-1010/.test(r.textContent||''));
  for(const r of rows) fireEvent.click(within(r).getAllByRole('checkbox')[0]);
  expect(screen.getByText(/تم تحديد \(2\)/)).toBeTruthy();
  fireEvent.change(search(),{target:{value:'QA-1001'}});
  expect(screen.queryByText(/تم تحديد \(/)).toBeNull();
});
