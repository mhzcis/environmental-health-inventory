import {describe,it,expect} from 'vitest';
import {importDate,importNumber,importTransactionId} from '../src/utils/importValidation';
describe('spreadsheet preflight',()=>{
 it.each(['','12abc','-2','NaN','Infinity'])('rejects malformed quantity %s',v=>expect(()=>importNumber(v,'كمية')).toThrow());
 it.each(['2026-02-31','2026-02-29','','not-a-date'])('rejects invalid date %s',v=>expect(()=>importDate(v)).toThrow());
 it('accepts Excel serials and unambiguous calendar dates',()=>{expect(importDate(25569)).toBe('1970-01-01');expect(importDate('29/02/2024')).toBe('2024-02-29');expect(importNumber('2.5','كمية')).toBe(2.5);});
 it('reimport identity is stable and preserves identical occurrences',async()=>{const fields=['m1','وارد',2,'wh1','QA','2026-11-04','QA'];const id=await importTransactionId(fields,0);expect(await importTransactionId(fields,0)).toBe(id);expect(await importTransactionId(fields,1)).not.toBe(id);expect(await importTransactionId([...fields.slice(0,-1),'changed'],0)).not.toBe(id);});
});

describe('QA-20261108 IMP-02 Arabic row messages', () => {
  it('validation messages are Arabic-only (not masked by safeUserMessage)', async () => {
    const { ImportRowError, ImportValidationError } = await import('../src/utils/importValidation');
    let msg = ''; try { importNumber('-1', 'الكمية'); } catch (e) { expect(e).toBeInstanceOf(ImportValidationError); msg = (e as Error).message; }
    expect(msg).not.toMatch(/[A-Za-z:/@]/);
    let d = ''; try { importDate('2026-13-40'); } catch (e) { d = (e as Error).message; }
    expect(d).not.toMatch(/[A-Za-z:/@]/);
    expect(new ImportRowError(7, msg).message).toMatch(/^السطر 7، /);
  });
});
