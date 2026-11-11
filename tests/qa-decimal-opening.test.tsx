// @vitest-environment jsdom
// QA 2026-11-06 FORM-02: opening/minimum stock inputs must accept decimals (transactions already use step="any").
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
vi.mock('../src/context/StorehouseContext',()=>({useStorehouse:()=>({selectedStorehouse:'QA-A'})}));
vi.mock('../src/services/dataService',()=>({dataService:{getSettings:()=>({organizationName:'QA',departmentName:'QA',categories:[{name:'QA',prefix:'QA'}],units:['قطعة'],storehouses:['QA-A'],expiryWarningThresholdDays:30}),getMaterials:()=>[],getTransactions:()=>[],getConfirmedTransactions:()=>[],getPendingTransactionIds:()=>new Set(),getPendingMaterialChanges:()=>[],getWorkingMaterials:()=>[],getCurrentUser:()=>({fullName:'QA'}),subscribe:()=>()=>{},generateItemCode:()=>'QA-1001',hasPermission:()=>true,saveTransactionBatch:vi.fn()}}));
import Materials from '../src/pages/Materials';
afterEach(()=>cleanup());
it('FORM-02 initialStock 2.75 and minimumStock 0.5 pass native constraint validation', async()=>{
  const {container}=render(<MemoryRouter><Materials/></MemoryRouter>);
  fireEvent.click(screen.getAllByText(/بطاقة صنف جديد/)[0]);
  await screen.findByText('تسجيل بطاقة صنف جديدة');
  const ini=document.querySelector('input[name=initialStock]') as HTMLInputElement;
  const min=document.querySelector('input[name=minimumStock]') as HTMLInputElement;
  expect(ini.getAttribute('step')).toBe('any'); expect(min.getAttribute('step')).toBe('any');
  fireEvent.change(ini,{target:{value:'2.75'}}); fireEvent.change(min,{target:{value:'0.5'}});
  expect(ini.validity.stepMismatch).toBe(false); expect(ini.checkValidity()).toBe(true); expect(min.checkValidity()).toBe(true);
  void container;
});
