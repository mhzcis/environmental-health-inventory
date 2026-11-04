// @vitest-environment jsdom
import fs from 'node:fs';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {Blob as NodeBlob} from 'node:buffer';
import ExcelJS from 'exceljs';
const fake=vi.hoisted(()=>({materials:[] as any[],transactions:[] as any[],logs:[] as any[],warehouse:'all',permissions:true,denied:[] as string[],pendingError:false,blocked:false,retry:vi.fn(),pdf:vi.fn(),save:vi.fn()}));
vi.mock('../src/services/dataService',()=>({dataService:{getSettings:()=>({organizationName:'QA معزول',departmentName:'QA فحص',expiryWarningThresholdDays:30,categories:[{name:'QA-C1'},{name:'QA-C2'}],units:['قطعة'],storehouses:['QA-A','QA-B'],partners:[]}),getMaterials:()=>fake.materials,getTransactions:()=>fake.transactions,getGeneratorLogs:()=>fake.logs,subscribe:()=>()=>{},hasPermission:(p:string)=>fake.permissions&&!fake.denied.includes(p),listPendingInventoryMutations:async()=>[{id:'qa-pending',status:fake.blocked?'blocked':'pending',operations:[],transport:'supabase-v1'}],retryPendingInventoryMutations:()=>fake.retry(),getOpeningStockAttachment:()=>null,getStorehouseInitialStock:(id:string,wh:string)=>fake.materials.find(m=>m.id===id)?.initialStocks?.[wh]||0}}));
vi.mock('../src/context/StorehouseContext',()=>({useStorehouse:()=>({selectedStorehouse:fake.warehouse,activeStorehouses:['QA-A','QA-B']})}));
vi.mock('../src/utils/printHtml',()=>({requireStableStringPart:(s:any)=>{if(typeof s!=='string'||!s.trim())throw new Error('invalid id');return s.trim();},exportToPDF:(...a:any[])=>fake.pdf(...a)}));
vi.mock('file-saver',()=>({saveAs:(...a:any[])=>fake.save(...a)}));
vi.mock('../src/components/CreateTransactionModal',()=>({default:()=>null}));
vi.mock('../src/services/supabaseOutbox',()=>({subscribeInventoryOutbox:()=>()=>{},InventoryPendingError:class extends Error {constructor(readonly mutationId:string,readonly blocked:boolean){super('QA pending');}}}));
import InventorySyncPanel from '../src/components/InventorySyncPanel';
import {InventoryPendingError} from '../src/services/supabaseOutbox';
import Reports from '../src/pages/Reports';
import Transactions from '../src/pages/Transactions';
import {MemoryRouter} from 'react-router-dom';
beforeEach(()=>{
 fake.warehouse='all';fake.permissions=true;fake.denied=[];fake.retry.mockReset();fake.blocked=false;fake.pdf.mockReset().mockResolvedValue(undefined);fake.save.mockReset();vi.stubGlobal('Blob',NodeBlob);
 const day=(n:number)=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
 fake.materials=Array.from({length:21},(_,i)=>({id:'qa-r'+i,code:'QA-'+String(1000+i),name:'QA صنف عربي '+i,category:i<10?'QA-C1':'QA-C2',type:'مادة',unit:'قطعة',minimumStock:5,currentStock:i,initialStock:i,initialStocks:{'QA-A':i},warehouseStocks:{'QA-A':i},storageLocation:'QA-A',expiryDate:i===1?day(-1):i===2?day(10):i===3?day(90):undefined}));
 fake.transactions=[{id:'qa-t1',itemId:'qa-r1',itemCode:'QA-1001',itemName:'QA صنف عربي 1',itemCategory:'QA-C1',unit:'قطعة',transactionType:'افتتاحي',quantity:1,date:'2026-11-01',transactionNumber:'QA-O1',storehouse:'QA-A',storehouseId:'qa-a',createdAt:'2026-11-01T00:00:00Z',executedBy:'QA'}];
 fake.logs=[{id:'qa-g1',date:'2026-11-01',previousReading:100,currentReading:110,operatingHours:10,createdBy:'QA'}];
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const labels=['تقرير الجرد العام وجرد الأرصدة المتوفرة حالياً','تقرير إنفاد مخزون الأمان','تقرير كشف فترات الصلاحيات وحالة الأصناف المشروطة بالصلاحية','سجل حركات المستودع التفصيلي','تقرير الموازنة والملخص الشامل','سند توثيق الأرصدة الافتتاحية','سجل تشغيل ومتابعة عداد المولد'];
async function choose(label:string){fireEvent.mouseDown(screen.getByRole('combobox',{name:'تحديد نوع التقرير الفني المراد توليده'}));fireEvent.click(await screen.findByRole('option',{name:new RegExp(label)}));}
async function excel(){fireEvent.click(screen.getByRole('button',{name:'تصدير اكسل'}));await waitFor(()=>expect(fake.save).toHaveBeenCalledOnce());const wb=new ExcelJS.Workbook();await wb.xlsx.load(await fake.save.mock.calls[0][0].arrayBuffer());return wb.worksheets[0];}
describe('QA_FULL Reports real UI with real Excel serialization; isolated data',()=>{
 it.each(labels.map((label,i)=>({label,i,count:[21,6,2,2,2,20,1][i]})))('OUT-01 OUT-02: actual Excel report $i has expected record count',async({label,i,count})=>{render(<Reports/>);if(i)await choose(label);const sheet=await excel();expect(sheet.rowCount-6).toBe(count);expect(sheet.views[0].rightToLeft).toBe(true);expect(sheet.getRow(6).actualCellCount).toBeGreaterThan(0);});
 it('OUT-02 SEC-03: spreadsheet keeps formula-like item names as strings',async()=>{fake.materials[0].name='=1+1';render(<Reports/>);const sheet=await excel();expect(sheet.getRow(7).getCell(2).value).toBe('=1+1');expect(sheet.getRow(7).getCell(2).type).toBe(ExcelJS.ValueType.String);});
 it('OUT-01: empty filtered warehouse exports headers and no fabricated records',async()=>{fake.warehouse='QA-B';render(<Reports/>);const sheet=await excel();expect(sheet.rowCount).toBe(6);});
 it('TAB-01 OUT-01: Excel exports all 21 records beyond 15-row UI page and has RTL view',async()=>{render(<Reports/>);const sheet=await excel();expect(sheet.rowCount).toBe(27);expect(sheet.views[0].rightToLeft).toBe(true);expect(sheet.getRow(27).getCell(1).value).toBe('QA-1020');expect(sheet.getRow(7).getCell(2).value).toBe('QA صنف عربي 0');});
 it('WH-02 REP-01 OUT-01: selected warehouse controls actual exported balances',async()=>{fake.warehouse='QA-B';fake.materials[0].warehouseStocks['QA-B']=30;render(<Reports/>);const sheet=await excel();expect(sheet.rowCount).toBe(7);expect(sheet.getRow(7).getCell(5).value).toBe(30);expect(sheet.getRow(7).getCell(7).value).toBe('QA-B');});
 it('REP-02: inventory category filter must apply in all-warehouse scope',async()=>{render(<Reports/>);fireEvent.mouseDown(screen.getByRole('combobox',{name:'تصفية حسب الفئة / التصنيف'}));fireEvent.click(await screen.findByRole('option',{name:/QA-C1/}));const sheet=await excel();expect(sheet.rowCount).toBe(16);});
 it('REP-03: low stock includes zero and exact minimum',async()=>{render(<Reports/>);await choose(labels[1]);const sheet=await excel();expect(sheet.rowCount).toBe(12);expect(Array.from({length:6},(_,i)=>sheet.getRow(i+7).getCell(5).value)).toEqual([0,1,2,3,4,5]);});
 it('REP-03: expiry report includes expired and near-expiry, excludes far expiry',async()=>{render(<Reports/>);await choose(labels[2]);const sheet=await excel();expect(sheet.rowCount).toBe(8);expect([sheet.getRow(7).getCell(1).value,sheet.getRow(8).getCell(1).value]).toEqual(['QA-1001','QA-1002']);});
 it('REP-04: category summary does not count aggregate parent twice',async()=>{fake.materials=[{...fake.materials[0],currentStock:120,warehouseStocks:{'QA-A':90,'QA-B':30}}];render(<Reports/>);await choose(labels[4]);const sheet=await excel();const total=Array.from({length:sheet.rowCount-6},(_,i)=>Number(sheet.getRow(i+7).getCell(4).value)).reduce((a,b)=>a+b,0);expect(total).toBe(120);});
 it.each(labels.map((label,i)=>({label,i})))('REP OUT-02: PDF data boundary report $i has matching unique identities',async({label,i})=>{render(<Reports/>);if(i)await choose(label);fireEvent.click(screen.getByRole('button',{name:'طباعة pdf'}));await waitFor(()=>expect(fake.pdf).toHaveBeenCalledOnce());const d=fake.pdf.mock.calls[0][0];for(const t of d.tables){expect(t.recordIds).toHaveLength(t.rows.length);expect(new Set(t.recordIds).size).toBe(t.rows.length);}expect(d.filename.endsWith('.pdf')).toBe(true);if(process.env.QA_PDF_DATA_DIR)fs.writeFileSync(`${process.env.QA_PDF_DATA_DIR}/report-${i}.json`,JSON.stringify(d));});
 it('OUT-04: Excel generation failure must show an error to the user',async()=>{render(<Reports/>);vi.spyOn(ExcelJS.Workbook.prototype,'xlsx','get').mockReturnValue({writeBuffer:async()=>{throw new Error('QA_EXPORT_FAILURE');}} as any);fireEvent.click(screen.getByRole('button',{name:'تصدير اكسل'}));await new Promise(r=>setTimeout(r,50));expect(screen.getByRole('alert').textContent).toMatch(/خطأ|فشل|تعذر/);});
 it('RBAC-02: no report output permission hides export and PDF buttons',()=>{fake.permissions=false;render(<Reports/>);expect(screen.queryByRole('button',{name:'تصدير اكسل'})).toBeNull();expect(screen.queryByRole('button',{name:'طباعة pdf'})).toBeNull();});
 it('SEC-03: material name remains literal at the typed PDF boundary',async()=>{fake.materials[0].name='<img id="qa-safe-sentinel" src="invalid" onerror="window.qaSentinel=1">';render(<Reports/>);fireEvent.click(screen.getByRole('button',{name:'طباعة pdf'}));await waitFor(()=>expect(fake.pdf).toHaveBeenCalledOnce());expect(fake.pdf.mock.calls[0][0].tables[0].rows[0][1]).toBe(fake.materials[0].name); /* Actual sink isolation is covered by remediation-print and real text-PDF QA. */});
});

it('RBAC report type cannot expose generator records without generator_log',async()=>{
 fake.denied=['generator_log'];render(<Reports/>);
 fireEvent.mouseDown(screen.getByRole('combobox',{name:'تحديد نوع التقرير الفني المراد توليده'}));
 expect((await screen.findByRole('option',{name:/سجل تشغيل ومتابعة عداد المولد/})).getAttribute('aria-disabled')).toBe('true');
 expect(screen.queryByText('qa-g1')).toBeNull();
});
it('RBAC revoking generator permission after selection removes the report and output controls',async()=>{
 const ui=render(<Reports/>);await choose(labels[6]);fake.denied=['generator_log'];ui.rerender(<Reports/>);
 expect(screen.getByRole('alert').textContent).toContain('لا تمتلك صلاحية');
 expect(screen.queryByRole('button',{name:'تصدير اكسل'})).toBeNull();
 expect(screen.queryByRole('button',{name:'طباعة pdf'})).toBeNull();expect(fake.pdf).not.toHaveBeenCalled();expect(fake.save).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'اختيار تقرير مسموح'}));
 expect(screen.getByRole('combobox',{name:'تحديد نوع التقرير الفني المراد توليده'})).toBeTruthy();
});
it.each([['reports_export','تصدير اكسل'],['reports_print','طباعة pdf']])('RBAC output handler rechecks %s after rendered permission changes',async(permission,label)=>{
 render(<Reports/>);fake.denied=[permission];fireEvent.click(screen.getByRole('button',{name:label}));
 expect(screen.getByRole('alert').textContent).toContain('لا تمتلك صلاحية');expect(fake.pdf).not.toHaveBeenCalled();expect(fake.save).not.toHaveBeenCalled();
});

const mountTransactions=()=>render(<MemoryRouter><Transactions/></MemoryRouter>);
it('RBAC transaction print and bulk output controls respect separate rights',()=>{
 fake.denied=['reports_print','reports_export','transactions_delete'];mountTransactions();
 expect((screen.getByRole('button',{name:'معاينة وطباعة السند المخزني'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(document.getElementById('select-all-transactions')!);
 expect((document.getElementById('bulk-export-transactions-pdf') as HTMLButtonElement).disabled).toBe(true);
 expect((document.getElementById('bulk-export-transactions-excel') as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByText('مؤرشفة')).toBeNull();expect(screen.getByText('الحذف غير مسموح')).toBeTruthy();
});
it.each([['reports_print','bulk-export-transactions-pdf'],['reports_export','bulk-export-transactions-excel']])('RBAC bulk output handler rechecks %s before producing a file',async(permission,id)=>{
 mountTransactions();fireEvent.click(document.getElementById('select-all-transactions')!);fake.denied=[permission];
 fireEvent.click(document.getElementById(id)!);
 expect(screen.getByRole('alert').textContent).toContain('لا تمتلك صلاحية');expect(fake.pdf).not.toHaveBeenCalled();expect(fake.save).not.toHaveBeenCalled();
});
it('RBAC voucher handler rechecks print right after preview was opened',async()=>{
 mountTransactions();fireEvent.click(screen.getByRole('button',{name:'معاينة وطباعة السند المخزني'}));
 const print=screen.getByRole('button',{name:/طباعة وإصدار المستند الآن/});fake.denied=['reports_print'];fireEvent.click(print);
 expect((await screen.findByRole('alert')).textContent).toContain('لا تمتلك صلاحية');expect(fake.pdf).not.toHaveBeenCalled();
});

it.each([true,false])('SYNC-04 retry message distinguishes blocked=%s from unknown acknowledgement',async(blocked)=>{
 fake.blocked=blocked;fake.retry.mockRejectedValue(new InventoryPendingError('qa-pending',blocked));render(<InventorySyncPanel/>);
 fireEvent.click(await screen.findByRole('button',{name:'إعادة إرسال الطلبات المحفوظة'}));
 const status=await screen.findByRole('status');expect(status.textContent).toContain(blocked?'رُفض الطلب':'لم يصل إقرار');
 expect(status.textContent).not.toContain('تعذر الاتصال بالخدمة مؤقت');expect(fake.retry).toHaveBeenCalledOnce();
});
