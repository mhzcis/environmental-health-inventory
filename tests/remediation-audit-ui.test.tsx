// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup,act} from '@testing-library/react';
const fake=vi.hoisted(()=>({logs:[] as any[],listener:()=>{}}));
vi.mock('../src/services/dataService',()=>({dataService:{getAuditLogs:()=>fake.logs,subscribe:(f:()=>void)=>{fake.listener=f;return()=>{};}}}));
import AuditLogs from '../src/pages/AuditLogs';
beforeEach(()=>{fake.logs=Array.from({length:39},(_,i)=>({id:'qa-a'+i,timestamp:'2026-11-01T12:00:00Z',user:'QA',action:i<5?'QA target':'QA other',details:'QA التفاصيل '+i,itemType:i<5?'حركة':'إعدادات'}));});
afterEach(cleanup);
async function page3(){render(<AuditLogs/>);const next=screen.getByRole('button',{name:/next page/i});fireEvent.click(next);fireEvent.click(next);expect(screen.getByText('QA التفاصيل 30')).toBeTruthy();}
it('F15 search from page three resets to first five results and handles zero',async()=>{await page3();const search=screen.getByPlaceholderText(/البحث بالإجراء/);fireEvent.change(search,{target:{value:'QA target'}});expect(screen.getByText('QA التفاصيل 0')).toBeTruthy();expect(screen.getAllByText('QA target')).toHaveLength(5);fireEvent.change(search,{target:{value:'absent'}});expect(screen.queryByText('QA التفاصيل 0')).toBeNull();});
it('F15 event type filter resets page',async()=>{await page3();fireEvent.mouseDown(screen.getByRole('combobox',{name:'تصفية نوع الحدث'}));fireEvent.click(await screen.findByRole('option',{name:/حركة مخازن/}));expect(screen.getByText('QA التفاصيل 0')).toBeTruthy();});
it('F15 remote list shrink clamps page without a new request',async()=>{await page3();fake.logs=fake.logs.slice(0,5);act(()=>fake.listener());await waitFor(()=>expect(screen.getByText('QA التفاصيل 0')).toBeTruthy());});
