// HTML Printer & RTL PDF Generation Utility for Native Arabic Support
// This generates fully styled A4 tables and charts with beautiful right-to-left (RTL) Arabic typography
// resulting in 100% searchable, copy-pasteable, and natively-connected PDF/Print exports.

import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

export function requireStableStringPart(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`معرّف غير صالح [${context}]: القيمة غائبة أو ليست نصاً (النوع: ${typeof value})`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`معرّف غير صالح [${context}]: القيمة نص فارغ`);
  }
  return trimmed;
}

export interface PrintData {
  title: string;
  organizationName: string;
  departmentName: string;
  metaFields: { label: string; value: string }[];
  tables: {
    title?: string;
    headers: string[];
    rows: string[][];
    recordIds: string[];
    columnAlignments?: ('right' | 'center' | 'left')[];
    rowBgColors?: (string | null)[];
  }[];
  notes?: string;
  signatures?: (string | { role: string; name: string; show?: boolean })[];
  barcode?: string;
}

export function printHtml(data: PrintData) {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.zIndex = '-1000';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document || iframe.contentDocument;
  if (!doc) {

    return;
  }

  const dateStr = new Date().toLocaleDateString('ar-EG');
  const timeStr = new Date().toLocaleTimeString('ar-EG');

  // Build metadata boxes
  let metaHtml = '';
  if (data.metaFields && data.metaFields.length > 0) {
    metaHtml += '<div class="meta-card-container"><table class="meta-table"><tbody>';
    for (let i = 0; i < data.metaFields.length; i += 2) {
      const field1 = data.metaFields[i];
      const field2 = data.metaFields[i + 1];
      
      metaHtml += '<tr>';
      metaHtml += `<td class="meta-label">${field1.label}</td>`;
      if (field2) {
        metaHtml += `<td class="meta-value">${field1.value || '-'}</td>`;
        metaHtml += `<td class="meta-label">${field2.label}</td>`;
        metaHtml += `<td class="meta-value">${field2.value || '-'}</td>`;
      } else {
        metaHtml += `<td class="meta-value" colspan="3">${field1.value || '-'}</td>`;
      }
      metaHtml += '</tr>';
    }
    metaHtml += '</tbody></table></div>';
  }

  // Build tables HTML
  let tablesHtml = '';
  data.tables.forEach(table => {
    let tableTitleHtml = table.title ? `<div class="section-title">${table.title}</div>` : '';
    
    let headerCells = table.headers.map(h => `<th>${h}</th>`).join('');
    
    let rowRows = table.rows.map((row, rowIndex) => {
      const bgColor = table.rowBgColors?.[rowIndex] ? `style="background-color: ${table.rowBgColors[rowIndex]}"` : '';
      const cells = row.map((cell, colIndex) => {
        const align = table.columnAlignments?.[colIndex] || 'right';
        const headerText = table.headers[colIndex] ? table.headers[colIndex].replace(/<[^>]+>/g, '') : '';
        const noWrapKeywords = ['كود', 'رقم', 'تاريخ', 'وقت', 'كمية', 'رصيد', 'وحدة', 'رمز', 'حالة'];
        const isNoWrap = noWrapKeywords.some(kw => headerText.includes(kw));
        const nowrapStyle = isNoWrap ? ' white-space: nowrap;' : '';
        return `<td class="align-${align}" style="${nowrapStyle}">${cell}</td>`;
      }).join('');
      return `<tr ${bgColor}>${cells}</tr>`;
    }).join('');

    tablesHtml += `
      <div class="table-container">
        ${tableTitleHtml}
        <table>
          <thead>
            <tr>${headerCells}</tr>
          </thead>
          <tbody>
            ${rowRows}
          </tbody>
        </table>
      </div>
    `;
  });

  // Notes HTML
  const notesHtml = data.notes 
    ? `<div class="notes-container">
        <div class="section-title">ملاحظات وتوجيهات عملية الصرف أو التوريد المعتمدة:</div>
        <p class="notes-text">${data.notes}</p>
       </div>`
    : '';

  // Signatures HTML
  let signaturesHtml = '';
  if (data.signatures && data.signatures.length > 0) {
    signaturesHtml += '<div class="signatures-grid">';
    data.signatures.forEach(sig => {
      let role = '';
      let name = '';
      let isVisible = true;
      
      if (typeof sig === 'string') {
        role = sig;
      } else {
        role = sig.role;
        name = sig.name || '';
        isVisible = sig.show !== false;
      }
      
      signaturesHtml += `
        <div class="signature-box" style="${isVisible ? '' : 'visibility: hidden;'}">
          <div class="sig-title">${role}</div>
          <div class="sig-name" style="margin-top: 10px; font-weight: bold; font-size: 14px; min-height: 20px;">${name}</div>
          <div class="sig-line" style="margin-top: 25px; color: #94a3b8; font-size: 13px;">التوقيع: <span style="color: #cbd5e1;">............................</span></div>
        </div>
      `;
    });
    signaturesHtml += '</div>';
  }

  // Barcode HTML
  const barcodeHtml = data.barcode 
    ? `<div class="barcode-container">
        <div class="barcode-lines">||||| | |||| || ||| | ||| |||| | | | ${data.barcode}</div>
        <div class="barcode-text">سند رسمي مشفر ومؤرشف إلكترونياً - رقم ${data.barcode}</div>
       </div>`
    : '';

  const htmlContent = `
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="UTF-8">
      <title>${data.title}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap');
        
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        body {
          font-family: 'Cairo', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background-color: #fff;
          color: #0f172a;
          line-height: 1.5;
          padding: 15mm 15mm;
          font-size: 11pt;
        }

        /* Top Header Styling */
        .page-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          border-bottom: 2px solid #cbd5e1;
          padding-bottom: 12px;
          margin-bottom: 25px;
        }

        .header-right {
          text-align: right;
        }

        .org-name {
          font-size: 14pt;
          font-weight: 700;
          color: #0c4a6e;
          margin-bottom: 4px;
        }

        .dept-name {
          font-size: 11pt;
          font-weight: 600;
          color: #475569;
        }

        .header-left {
          text-align: left;
          font-size: 10pt;
          color: #475569;
          font-weight: 400;
          line-height: 1.6;
        }

        /* Report Title */
        .report-title-container {
          text-align: center;
          margin-bottom: 25px;
        }

        .report-title {
          display: inline-block;
          font-size: 15pt;
          font-weight: 700;
          color: #0f172a;
          padding: 6px 20px;
          border-bottom: 3px solid #0284c7;
        }

        /* Metadata Card Table Layout (Vouchers and Report Metadata) */
        .meta-card-container {
          margin-bottom: 25px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          overflow: hidden;
          background-color: #cbd5e1;
          box-sizing: border-box;
        }

        .meta-table {
          width: 100%;
          border-collapse: separate;
          border-spacing: 0;
          background-color: #cbd5e1;
          empty-cells: show;
        }

        .meta-table td {
          padding: 8px 10px;
          font-size: 10pt;
          border-bottom: 1px solid #cbd5e1;
          border-left: 1px solid #cbd5e1;
          border-top: none !important;
          border-right: none !important;
          box-sizing: border-box !important;
          background-clip: padding-box !important;
          vertical-align: middle;
        }

        .meta-table tr:last-child td {
          border-bottom: none !important;
        }

        .meta-table td:last-child {
          border-left: none !important;
        }

        .meta-table .meta-label {
          background-color: #f1f5f9;
          font-weight: 700;
          color: #334155;
          width: 20%;
          text-align: right;
        }

        .meta-table .meta-value {
          background-color: #ffffff;
          font-weight: 600;
          color: #0f172a;
          width: 30%;
          text-align: right;
        }

        /* General Data Tables and Section Title */
        .section-title {
          font-size: 11pt;
          font-weight: 700;
          color: #0f172a;
          margin-bottom: 8px;
          border-right: 4px solid #0284c7;
          padding-right: 8px;
        }

        .table-container {
          margin-bottom: 25px;
          border: none;
          background-color: transparent;
          overflow: visible !important;
          box-sizing: border-box;
          flex-shrink: 0;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          border-spacing: 0;
          margin-top: 0;
          font-size: 9.5pt;
          background-color: transparent;
        }

        th {
          background-color: #1e293b;
          color: #ffffff;
          font-weight: 700;
          padding: 8px 10px;
          border: 1px solid #cbd5e1;
          text-align: center !important;
          box-sizing: border-box !important;
        }

        td {
          padding: 8px 12px;
          border: 1px solid #cbd5e1;
          color: #334155;
          text-align: center !important;
          box-sizing: border-box !important;
        }

        tr:nth-child(even) td {
          background-color: #f8fafc;
        }

        tr:nth-child(odd) td {
          background-color: #ffffff;
        }

        .align-right { text-align: right; }
        .align-center { text-align: center; }
        .align-left { text-align: left; }

        /* Notes Block */
        .notes-container {
          margin-top: 20px;
          margin-bottom: 25px;
          background-color: #f8fafc;
          border-radius: 8px;
          padding: 12px 15px;
          border-right: 4px solid #64748b;
        }

        .notes-text {
          font-size: 9.5pt;
          color: #475569;
          margin-top: 6px;
        }

        /* Signatures Grid layout */
        .signatures-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 15px;
          margin-top: 40px;
          margin-bottom: 30px;
          text-align: center;
        }

        .signature-box {
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          height: 75px;
        }

        .sig-title {
          font-weight: 700;
          font-size: 9.5pt;
          color: #1e293b;
        }

        .sig-line {
          font-size: 8pt;
          color: #94a3b8;
          margin-top: 15px;
        }

        /* Barcode footer */
        .barcode-container {
          text-align: center;
          margin-top: 30px;
          border-top: 1px dashed #cbd5e1;
          padding-top: 15px;
          color: #64748b;
        }

        .barcode-lines {
          font-family: 'monospace';
          font-size: 11pt;
          letter-spacing: 2px;
          margin-bottom: 4px;
        }

        .barcode-text {
          font-size: 7.5pt;
        }

        /* CSS rules to control printer pagination layout */
        @media print {
          body {
            padding: 0;
            font-size: 10pt;
          }
          th {
            background-color: #1e293b !important;
            color: #ffffff !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          tr:nth-child(even) {
            background-color: #f8fafc !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .meta-label {
            background-color: #f1f5f9 !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .signatures-grid, .notes-container, .table-container {
            page-break-inside: avoid;
          }
        }
      </style>
    </head>
    <body onload="window.print();">
      <div class="page-header">
        <div class="header-right">
          <div class="org-name">${data.organizationName}</div>
          <div class="dept-name">${data.departmentName}</div>
        </div>
        <div class="header-left">
          <div>تاريخ التصدير: ${dateStr}</div>
          <div>وقت التصدير: ${timeStr}</div>
        </div>
      </div>

      <div class="report-title-container">
        <div class="report-title">${data.title}</div>
      </div>

      ${metaHtml}
      ${tablesHtml}
      ${notesHtml}
      ${signaturesHtml}
      ${barcodeHtml}
    </body>
    </html>
  `;

  doc.open();
  doc.write(htmlContent);
  doc.close();

  // Focus and trigger window.print on the iframe
  setTimeout(() => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (_) {}
  }, 250);

  // Remove the iframe from DOM after print dialog is closed
  setTimeout(() => {
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  }, 60000); // 60 seconds timeout to allow print dialog to complete
}

const DEFAULT_PAGE_WIDTH_PORTRAIT = 820;
const DEFAULT_PAGE_HEIGHT_PORTRAIT = 1195;
const DEFAULT_PAGE_WIDTH_LANDSCAPE = 1120;
const DEFAULT_PAGE_HEIGHT_LANDSCAPE = 768;
const PAGE_PADDING_PX = 30;
const FONT_LOAD_WAIT_SHORT_MS = 100;
const FONT_LOAD_WAIT_LONG_MS = 300;
const HTML2CANVAS_SCALE = 2.2;
const JPEG_QUALITY = 0.95;

export async function exportToPDF(data: PrintData & { filename: string; orientation?: 'portrait' | 'landscape' }) {
  const isLandscape = data.orientation === 'landscape';
  
  // 1. Unify page dimensions between CSS, html2canvas, and jsPDF (A4).
  const PAGE_WIDTH = isLandscape ? DEFAULT_PAGE_WIDTH_LANDSCAPE : DEFAULT_PAGE_WIDTH_PORTRAIT;
  // A4 ratio for print area with 10mm margins
  const PAGE_HEIGHT = isLandscape ? DEFAULT_PAGE_HEIGHT_LANDSCAPE : DEFAULT_PAGE_HEIGHT_PORTRAIT;
  // Preflight validation
  const sourceRecordIds: string[][] = [];
  if (!Array.isArray(data.tables)) throw new Error('data.tables is missing or invalid');
  data.tables.forEach((t, tIdx) => {
    if (!Array.isArray(t.recordIds)) throw new Error(`الجدول ${tIdx} يفتقد recordIds`);
    if (t.recordIds.length !== t.rows.length) throw new Error(`الجدول ${tIdx}: عدد recordIds (${t.recordIds.length}) لا يطابق rows (${t.rows.length})`);
    const tableIds: string[] = [];
    const idSet = new Set<string>();
    t.recordIds.forEach((id, rIdx) => {
      if (typeof id !== 'string') throw new Error(`الجدول ${tIdx} الصف ${rIdx}: الهوية ليست نصاً`);
      const trimmed = id.trim();
      if (!trimmed) throw new Error(`الجدول ${tIdx} الصف ${rIdx}: الهوية نص فارغ`);
      if (idSet.has(trimmed)) throw new Error(`الجدول ${tIdx} الصف ${rIdx}: تكرار في الهوية [${trimmed}]`);
      idSet.add(trimmed);
      tableIds.push(trimmed);
    });
    sourceRecordIds.push(tableIds);
  });
  
  const rowIdentityMap = new WeakMap<HTMLTableRowElement, { tableIndex: number, recordId: string }>();

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.left = '-9999px';
  iframe.style.top = '0';
  iframe.style.width = `${PAGE_WIDTH}px`;
  iframe.style.height = `${PAGE_HEIGHT}px`;
  iframe.style.border = '0';
  iframe.style.opacity = '0.01';
  iframe.style.pointerEvents = 'none';
  iframe.style.zIndex = '-9999';
  document.body.appendChild(iframe);
  
  const idoc = iframe.contentWindow?.document;
  if (!idoc) {
    document.body.removeChild(iframe);
    throw new Error('Could not open iframe document for PDF generation');
  }

  const dateStr = new Date().toLocaleDateString('ar-EG');
  const timeStr = new Date().toLocaleTimeString('ar-EG');

  // 2. Setup iframe with identical styles
  idoc.open();
  idoc.write(`
    <html dir="rtl">
      <head>
        <style>
        @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;850&display=swap');
        
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        body {
          font-family: 'Cairo', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background-color: #f1f5f9;
          color: #0f172a;
          line-height: 1.5;
          width: ${PAGE_WIDTH}px;
          box-sizing: border-box;
        }

        #capture-root {
          display: flex;
          flex-direction: column;
          gap: 20px;
          background-color: #f1f5f9;
        }

        .pdf-page {
          width: ${PAGE_WIDTH}px;
          height: ${PAGE_HEIGHT}px;
          padding: 30px;
          box-sizing: border-box;
          background-color: #ffffff;
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
          position: relative;
        }

        /* Top Header Styling */
        .page-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          border-bottom: 3px solid #007ab7;
          padding-bottom: 15px;
          margin-bottom: 25px;
        }

        .header-right {
          text-align: right;
        }

        .org-name {
          font-size: 16px;
          font-weight: 700;
          color: #00557f;
          margin-bottom: 4px;
        }

        .dept-name {
          font-size: 12px;
          font-weight: 600;
          color: #3394c5;
        }

        .header-left {
          text-align: left;
          font-size: 12px;
          color: #475569;
          font-weight: 500;
          line-height: 1.6;
        }

        /* Report Title */
        .report-title-container {
          text-align: center;
          margin-bottom: 25px;
        }

        .report-title {
          display: inline-block;
          font-size: 18px;
          font-weight: 700;
          color: #00557f;
          padding: 6px 20px;
          border-bottom: 3px solid #3394c5;
        }

        /* Metadata Card Table Layout */
        .meta-card-container {
          margin-bottom: 20px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          overflow: hidden;
          background-color: #cbd5e1;
          box-sizing: border-box;
        }

        .meta-table {
          width: 100%;
          border-collapse: separate;
          border-spacing: 0;
          background-color: #cbd5e1;
          empty-cells: show;
        }

        .meta-table td {
          padding: 8px 10px;
          font-size: 11.5px;
          border-bottom: 1px solid #cbd5e1;
          border-left: 1px solid #cbd5e1;
          border-top: none !important;
          border-right: none !important;
          box-sizing: border-box !important;
          background-clip: padding-box !important;
          vertical-align: middle;
        }

        .meta-table tr:last-child td {
          border-bottom: none !important;
        }

        .meta-table td:last-child {
          border-left: none !important;
        }

        .meta-table .meta-label {
          background-color: #f1f5f9;
          font-weight: 700;
          color: #475569;
          width: 20%;
          text-align: right;
        }

        .meta-table .meta-value {
          background-color: #ffffff;
          font-weight: 600;
          color: #0f172a;
          width: 30%;
          text-align: right;
        }

        /* General Data Tables and Section Title */
        .section-title {
          font-size: 13px;
          font-weight: 700;
          color: #00557f;
          margin-bottom: 8px;
          border-right: 4px solid #007ab7;
          padding-right: 8px;
        }

        .table-container {
          margin-bottom: 20px;
          border: none;
          background-color: transparent;
          overflow: visible !important;
          box-sizing: border-box;
          flex-shrink: 0;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          border-spacing: 0;
          margin-top: 0;
          font-size: 11.5px;
          background-color: transparent;
        }

        th {
          background-color: #007ab7;
          color: #ffffff;
          font-weight: 700;
          padding: 8px 10px;
          border: 1px solid #cbd5e1;
          text-align: center !important;
          box-sizing: border-box !important;
        }

        td {
          padding: 8px 12px;
          border: 1px solid #cbd5e1;
          color: #334155;
          font-weight: 600;
          text-align: center !important;
          box-sizing: border-box !important;
        }

        tr:nth-child(even) td {
          background-color: #f1f5f9;
        }

        tr:nth-child(odd) td {
          background-color: #ffffff;
        }

        .align-right { text-align: right; }
        .align-center { text-align: center; }
        .align-left { text-align: left; }

        td span {
          display: inline-block !important;
          line-height: 1.2 !important;
          vertical-align: middle !important;
          box-sizing: border-box !important;
        }

        /* Notes Block */
        .notes-container {
          margin-top: 20px;
          margin-bottom: 25px;
          background-color: #f8fafc;
          border-radius: 8px;
          padding: 12px 15px;
          border-right: 4px solid #007ab7;
        }

        .notes-text {
          font-size: 12px;
          color: #475569;
          margin-top: 6px;
          font-weight: 600;
        }

        /* Signatures Grid layout */
        .signatures-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 15px;
          margin-top: 40px;
          margin-bottom: 30px;
          text-align: center;
        }

        .signature-box {
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        /* Barcode Layout */
        .barcode-container {
          text-align: center;
          margin-top: 40px;
          margin-bottom: 20px;
        }
        
        .barcode-container svg {
          max-height: 50px;
        }
        </style>
      </head>
      <body>
        <div id="measure-container" class="pdf-page" style="position: absolute; visibility: hidden; height: auto; min-height: unset; overflow: visible;">
        </div>
        <div id="pages-container"></div>
      </body>
    </html>
  `);
  idoc.close();

    // Wait for fonts to load before measuring text
    if (iframe.contentWindow && iframe.contentWindow.document) {
      await iframe.contentWindow.document.fonts.ready;
    }

  try {

  // Wait for fonts and styles to load
  await new Promise(r => setTimeout(r, FONT_LOAD_WAIT_SHORT_MS)); // wait for DOM parsing
  if (iframe.contentWindow && iframe.contentWindow.document.fonts) {
    await iframe.contentWindow.document.fonts.ready;
  }
  await new Promise(r => setTimeout(r, FONT_LOAD_WAIT_LONG_MS)); // wait for rendering

  const measureContainer = idoc.getElementById('measure-container') as HTMLElement;
  const pagesContainer = idoc.getElementById('pages-container') as HTMLElement;

  // 3. Render full tables in measure-container to determine column widths
  data.tables.forEach((table, tIdx) => {
    let tableHtml = '';
    if (table.title) {
      tableHtml += `<div class="section-title">${table.title}</div>`;
    }
    tableHtml += `<table id="measure-table-${tIdx}"><thead><tr>`;
    table.headers.forEach(h => {
      tableHtml += `<th>${h}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';
    table.rows.forEach((row, rIdx) => {
      const bgColor = table.rowBgColors?.[rIdx] ? ` style="background-color: ${table.rowBgColors[rIdx]}"` : '';
      tableHtml += `<tr${bgColor}>`;
      row.forEach((cell, cIdx) => {
        const align = table.columnAlignments?.[cIdx] || 'right';
        const headerText = table.headers[cIdx] ? table.headers[cIdx].replace(/<[^>]+>/g, '') : '';
        const noWrapKeywords = ['كود', 'رقم', 'تاريخ', 'وقت', 'كمية', 'رصيد', 'وحدة', 'رمز', 'حالة'];
        const isNoWrap = noWrapKeywords.some(kw => headerText.includes(kw));
        const nowrapStyle = isNoWrap ? ' white-space: nowrap;' : '';
        tableHtml += `<td class="align-${align}" style="${nowrapStyle}">${cell}</td>`;
      });
      tableHtml += '</tr>';
    });
    tableHtml += '</tbody></table>';
    measureContainer.insertAdjacentHTML('beforeend', tableHtml);
  });

  // Extract measured column widths
  const tableColWidths: number[][] = [];
  data.tables.forEach((_, tIdx) => {
    const tableEl = idoc.getElementById(`measure-table-${tIdx}`) as HTMLTableElement;
    if (tableEl && tableEl.rows[0]) {
      const widths = Array.from(tableEl.rows[0].cells).map(cell => cell.getBoundingClientRect().width);
      tableColWidths.push(widths);
    } else {
      tableColWidths.push([]);
    }
  });

  measureContainer.innerHTML = ''; // clear

  // 4. Helpers to build pages
  
  let currentPageNum = 0;
  
  // Available height per page
  // .pdf-page has 30px padding. box-sizing is border-box.
  // The usable height inside .pdf-page is PAGE_HEIGHT - 60.
  const USABLE_HEIGHT = PAGE_HEIGHT - (PAGE_PADDING_PX * 2);
  const MAX_USABLE_HEIGHT = USABLE_HEIGHT + 1.5; // Subpixel layout tolerance to prevent false page splits
  
  const createNewPage = () => {
    currentPageNum++;
    const pageDiv = idoc.createElement('div');
    pageDiv.className = 'pdf-page';
    // set absolute to avoid scrollbar layout shift during measurement
    pageDiv.style.position = 'absolute'; 
    pageDiv.style.top = '0';
    pageDiv.style.left = '0';
    pageDiv.style.visibility = 'hidden';
    
    // Header
    pageDiv.innerHTML = `
      <div class="page-header" id="header-page-${currentPageNum}">
        <div class="header-right">
          <div class="org-name">${data.organizationName}</div>
          <div class="dept-name">${data.departmentName}</div>
        </div>
        <div class="header-left">
          <div>تاريخ التصدير: ${dateStr}</div>
          <div>وقت التصدير: ${timeStr}</div>
          <div class="page-num-placeholder" style="font-size: 10px; font-weight: bold; margin-top: 4px; min-height: 15px; line-height: 1.5; color: #64748b;">صفحة 0 من 0</div>
        </div>
      </div>
    `;

    if (currentPageNum === 1) {
      if (data.title) {
        pageDiv.insertAdjacentHTML('beforeend', `
          <div class="report-title-container">
            <div class="report-title">${data.title}</div>
          </div>
        `);
      }
      if (data.metaFields && data.metaFields.length > 0) {
        let metaHtml = '<div class="meta-card-container"><table class="meta-table"><tbody>';
        for (let i = 0; i < data.metaFields.length; i += 2) {
          const field1 = data.metaFields[i];
          const field2 = data.metaFields[i + 1];
          
          metaHtml += '<tr>';
          metaHtml += `<td class="meta-label">${field1.label}</td>`;
          if (field2) {
            metaHtml += `<td class="meta-value">${field1.value || '-'}</td>`;
            metaHtml += `<td class="meta-label">${field2.label}</td>`;
            metaHtml += `<td class="meta-value">${field2.value || '-'}</td>`;
          } else {
            metaHtml += `<td class="meta-value" colspan="3">${field1.value || '-'}</td>`;
          }
          metaHtml += '</tr>';
        }
        metaHtml += '</tbody></table></div>';
        pageDiv.insertAdjacentHTML('beforeend', metaHtml);
      }
    }
    
    pagesContainer.appendChild(pageDiv);
    
    return pageDiv;
  };

  const getUsedHeight = (container: HTMLElement) => {
    const children = Array.from(container.children);
    if (children.length === 0) return 0;
    const lastChild = children[children.length - 1] as HTMLElement;
    const containerRect = container.getBoundingClientRect();
    const lastChildRect = lastChild.getBoundingClientRect();
    return lastChildRect.bottom - containerRect.top - 30; // 30 is top padding
  };

  let pageDiv = createNewPage();

  // Track original vs rendered rows for validation
  let totalOriginalRows = 0;
  let totalRenderedRows = 0;

  // 5. Append tables and rows
  for (let tIdx = 0; tIdx < data.tables.length; tIdx++) {
    const tableData = data.tables[tIdx];
    const colWidths = tableColWidths[tIdx];
    totalOriginalRows += tableData.rows.length;
    
    let isNewTablePart = true;
    let currentTableEl: HTMLTableElement | null = null;
    let currentTbodyEl: HTMLTableSectionElement | null = null;
    let currentTableContainer: HTMLDivElement | null = null;
    let currentSectionTitleEl: HTMLDivElement | null = null;
    
    const startTableOnCurrentPage = () => {
      // Add table title if it's the first part of this table
      currentSectionTitleEl = null;
      if (isNewTablePart && tableData.title) {
        const titleEl = idoc.createElement('div');
        titleEl.className = 'section-title';
        titleEl.textContent = tableData.title;
        pageDiv.appendChild(titleEl);
        currentSectionTitleEl = titleEl;
      }
      
      currentTableContainer = idoc.createElement('div');
      currentTableContainer.className = 'table-container';
      
      currentTableEl = idoc.createElement('table');
      const thead = idoc.createElement('thead');
      const headerRow = idoc.createElement('tr');
      
      tableData.headers.forEach((h, cIdx) => {
        const th = idoc.createElement('th');
        th.innerHTML = h; // use innerHTML to allow tags
        if (colWidths && colWidths[cIdx]) {
          th.style.width = `${colWidths[cIdx]}px`;
          th.style.maxWidth = `${colWidths[cIdx]}px`;
        }
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      currentTableEl.appendChild(thead);
      
      currentTbodyEl = idoc.createElement('tbody');
      currentTableEl.appendChild(currentTbodyEl);
      currentTableContainer.appendChild(currentTableEl);
      pageDiv.appendChild(currentTableContainer);
      isNewTablePart = false;
    };
    
    startTableOnCurrentPage();
    
    for (let rIdx = 0; rIdx < tableData.rows.length; rIdx++) {
      const rowData = tableData.rows[rIdx];
      const tr = idoc.createElement('tr');
      rowIdentityMap.set(tr, { tableIndex: tIdx, recordId: sourceRecordIds[tIdx][rIdx] });
      

      if (tableData.rowBgColors && tableData.rowBgColors[rIdx]) {
        tr.style.backgroundColor = tableData.rowBgColors[rIdx]!;
      }
      
      rowData.forEach((cell, cIdx) => {
        const td = idoc.createElement('td');
        td.className = `align-${tableData.columnAlignments?.[cIdx] || 'right'}`;
        td.style.wordBreak = 'break-word';
        const headerText = tableData.headers[cIdx] ? tableData.headers[cIdx].replace(/<[^>]+>/g, '') : '';
        const noWrapKeywords = ['كود', 'رقم', 'تاريخ', 'وقت', 'كمية', 'رصيد', 'وحدة', 'رمز', 'حالة'];
        if (noWrapKeywords.some(kw => headerText.includes(kw)) && headerText.length <= 16) {
          td.style.whiteSpace = 'nowrap';
        }
        td.innerHTML = cell;
        tr.appendChild(td);
      });
      
      currentTbodyEl!.appendChild(tr);
      totalRenderedRows++;
      
      let usedHeight = getUsedHeight(pageDiv);
      
      if (usedHeight > MAX_USABLE_HEIGHT) {
        // Row exceeds current page usable height
        currentTbodyEl!.removeChild(tr);
        totalRenderedRows--;
        
        if (currentTbodyEl!.children.length === 0) {
          // First-row overflow on current page!
          // Clean up empty table container and title from current pageDiv
          if (currentTableContainer && currentTableContainer.parentNode === pageDiv) {
            pageDiv.removeChild(currentTableContainer);
          }
          if (currentSectionTitleEl && currentSectionTitleEl.parentNode === pageDiv) {
            pageDiv.removeChild(currentSectionTitleEl);
          }
          
          // Create new page for this table part
          pageDiv = createNewPage();
          isNewTablePart = true; // Title should appear on new page
          startTableOnCurrentPage();
          
          currentTbodyEl!.appendChild(tr);
          totalRenderedRows++;
          
          usedHeight = getUsedHeight(pageDiv);
          if (usedHeight > MAX_USABLE_HEIGHT) {
            // Row STILL overflows on a fresh page with 0 previous rows!
            // This single row is inherently taller than a full printable A4 page.
            currentTbodyEl!.removeChild(tr);
            totalRenderedRows--;
            if (currentTableContainer && currentTableContainer.parentNode === pageDiv) {
              pageDiv.removeChild(currentTableContainer);
            }
            if (currentSectionTitleEl && currentSectionTitleEl.parentNode === pageDiv) {
              pageDiv.removeChild(currentSectionTitleEl);
            }
            
            const errorMsg = `خطأ في إنشاء المستند: السجل رقم ${rIdx + 1} في الجدول "${tableData.title || tIdx + 1}" يحتوي على محتوى يتجاوز ارتفاع صفحة كاملة (${Math.round(usedHeight)}px > ${USABLE_HEIGHT}px). تم إيقاف التصدير لتجنب مستند ناقص.`;
            if (typeof window !== 'undefined') {
              alert(errorMsg);
            }
            throw new Error(errorMsg);
          }
        } else {
          // Move to next page for this row
          pageDiv = createNewPage();
          isNewTablePart = false; // Continuing table part: keep table header, do not repeat section title
          startTableOnCurrentPage();
          
          currentTbodyEl!.appendChild(tr);
          totalRenderedRows++;
          
          usedHeight = getUsedHeight(pageDiv);
          if (usedHeight > MAX_USABLE_HEIGHT) {
            // Single row on fresh page still exceeds USABLE_HEIGHT
            currentTbodyEl!.removeChild(tr);
            totalRenderedRows--;
            if (currentTableContainer && currentTableContainer.parentNode === pageDiv) {
              pageDiv.removeChild(currentTableContainer);
            }
            if (currentSectionTitleEl && currentSectionTitleEl.parentNode === pageDiv) {
              pageDiv.removeChild(currentSectionTitleEl);
            }
            
            const errorMsg = `خطأ في إنشاء المستند: السجل رقم ${rIdx + 1} في الجدول "${tableData.title || tIdx + 1}" يحتوي على محتوى يتجاوز ارتفاع صفحة كاملة (${Math.round(usedHeight)}px > ${USABLE_HEIGHT}px). تم إيقاف التصدير لتجنب مستند ناقص.`;
            if (typeof window !== 'undefined') {
              alert(errorMsg);
            }
            throw new Error(errorMsg);
          }
        }
      }
    }
  }

  // 6. Append Notes, Signatures, Barcode individually with page overflow checks
  if (data.notes) {
    const notesDiv = idoc.createElement('div');
    notesDiv.className = 'notes-container';
    notesDiv.style.marginTop = '20px';
    notesDiv.innerHTML = `<div class="section-title">ملاحظات</div><div class="notes-text">${data.notes.replace(/\n/g, '<br />')}</div>`;
    pageDiv.appendChild(notesDiv);
    
    if (getUsedHeight(pageDiv) > MAX_USABLE_HEIGHT) {
      pageDiv.removeChild(notesDiv);
      pageDiv = createNewPage();
      pageDiv.appendChild(notesDiv);
    }
  }

  if (data.signatures && data.signatures.length > 0) {
    const sigsDiv = idoc.createElement('div');
    sigsDiv.className = 'signatures-grid';
    data.signatures.forEach(sig => {
      let role = '';
      let name = '';
      let isVisible = true;
      if (typeof sig === 'string') {
        role = sig;
      } else {
        role = sig.role;
        name = sig.name || '';
        isVisible = sig.show !== false;
      }
      sigsDiv.insertAdjacentHTML('beforeend', `
        <div class="signature-box" style="${isVisible ? '' : 'visibility: hidden;'}">
          <div class="signature-role" style="font-size: 12px; font-weight: 700; color: #334155;">${role}</div>
          <div class="signature-name" style="font-size: 13px; font-weight: bold; color: #000; margin-top: 5px; min-height: 18px;">${name}</div>
          <div class="signature-line" style="margin-top: 25px; color: #94a3b8; font-size: 13px;">التوقيع: <span style="color: #cbd5e1;">............................</span></div>
        </div>
      `);
    });
    pageDiv.appendChild(sigsDiv);
    
    if (getUsedHeight(pageDiv) > MAX_USABLE_HEIGHT) {
      pageDiv.removeChild(sigsDiv);
      pageDiv = createNewPage();
      pageDiv.appendChild(sigsDiv);
    }
  }

  if (data.barcode) {
    const barcodeDiv = idoc.createElement('div');
    barcodeDiv.className = 'barcode-container';
    barcodeDiv.innerHTML = `
      <div style="text-align: center; margin-top: 20px; padding-top: 15px; border-top: 1px dashed #cbd5e1;">
        <div class="barcode-lines" style="font-family: monospace; letter-spacing: 4px; color: #000; font-size: 14px; margin-bottom: 5px;">||||| | |||| || ||| | ||| |||| | | | ${data.barcode}</div>
        <div class="barcode-text" style="font-family: 'Cairo', sans-serif; font-size: 11px; color: #64748b;">سند رسمي مشفر ومؤرشف إلكترونياً - رقم ${data.barcode}</div>
      </div>
    `;
    pageDiv.appendChild(barcodeDiv);
    
    if (getUsedHeight(pageDiv) > MAX_USABLE_HEIGHT) {
      pageDiv.removeChild(barcodeDiv);
      pageDiv = createNewPage();
      pageDiv.appendChild(barcodeDiv);
    }
  }

  // 7. Cleanup Empty Containers and Orphaned Section Titles across all pages
  const pageNodes = Array.from(pagesContainer.children) as HTMLElement[];
  pageNodes.forEach((p, pIdx) => {
    // Remove empty table containers
    const tableContainers = Array.from(p.querySelectorAll('.table-container')) as HTMLElement[];
    tableContainers.forEach(tc => {
      const tbody = tc.querySelector('tbody');
      if (!tbody || tbody.children.length === 0) {
        tc.remove();
      }
    });

    // Remove orphaned table section titles that are direct children of pageDiv
    const directTitles = (Array.from(p.children) as HTMLElement[]).filter(c => c.classList.contains('section-title'));
    directTitles.forEach(t => {
      const next = t.nextElementSibling;
      if (!next || !next.classList.contains('table-container')) {
        t.remove();
      }
    });

    // Remove empty pages with no data content if page count > 1
    if (pIdx > 0) {
      const hasContent = p.querySelector('.meta-card-container, .table-container, .notes-container, .signatures-grid, .barcode-container');
      if (!hasContent) {
        p.remove();
      }
    }
  });

  // Re-query remaining valid pages
  const allPages = Array.from(pagesContainer.children) as HTMLElement[];
  allPages.forEach((p, idx) => {
    const pageNumPlaceholder = p.querySelector('.page-num-placeholder');
    if (pageNumPlaceholder) {
      pageNumPlaceholder.textContent = `صفحة ${idx + 1} من ${allPages.length}`;
    }
    p.style.position = 'relative'; // restore layout positioning
    p.style.visibility = 'visible';
  });

  // Final DOM scan for record IDs
  
  
  const renderedRecordIds: string[][] = Array.from({ length: sourceRecordIds.length }, () => [] as string[]);
  const allDataRows = Array.from(idoc.querySelectorAll('.table-container tbody > tr')) as HTMLTableRowElement[];
  
  let lastSeenTableIndex = -1;
  allDataRows.forEach((tr, domIdx) => {
    const identity = rowIdentityMap.get(tr);
    if (!identity) {
      throw new Error(`صف DOM ${domIdx} مجهول الهوية ولم يتم إنشاؤه عبر المصدر`);
    }
    
    if (identity.tableIndex < 0 || identity.tableIndex >= sourceRecordIds.length) {
      throw new Error(`الجدول ${identity.tableIndex} خارج النطاق للصف ${domIdx}`);
    }
    if (identity.tableIndex < lastSeenTableIndex) {
      throw new Error(`تداخل غير منطقي: الجدول ${identity.tableIndex} ظهر بعد الجدول ${lastSeenTableIndex}`);
    }
    lastSeenTableIndex = identity.tableIndex;
    renderedRecordIds[identity.tableIndex].push(identity.recordId);
  });
  
  sourceRecordIds.forEach((sourceTblIds, tIdx) => {
    const renderedTblIds = renderedRecordIds[tIdx];
    if (sourceTblIds.length !== renderedTblIds.length) {
      throw new Error(`الجدول ${tIdx}: عدد السجلات المرسومة (${renderedTblIds.length}) لا يطابق الأصلية (${sourceTblIds.length})`);
    }
    const renderedSet = new Set<string>();
    renderedTblIds.forEach((id, rIdx) => {
      if (renderedSet.has(id)) throw new Error(`الجدول ${tIdx}: تكرار السجل المرسوم في الصف ${rIdx}`);
      renderedSet.add(id);
      if (id !== sourceTblIds[rIdx]) {
        throw new Error(`الجدول ${tIdx} الصف ${rIdx}: ترتيب غير متطابق أو استبدال`);
      }
    });
  });

  // 8. Strict Audit Validations
  if (totalOriginalRows !== totalRenderedRows) {
    const errorMsg = `خطأ في التحقق من صحة عدد السجلات: المتوقع ${totalOriginalRows} سجلاً، بينما تم رسم ${totalRenderedRows} سجلاً. تم إيقاف إنشاء PDF لتجنب بيانات مفقودة.`;
    if (typeof window !== 'undefined') {
      alert(errorMsg);
    }
    throw new Error(errorMsg);
  }

  for (let i = 0; i < allPages.length; i++) {
    const p = allPages[i];
    const pageUsedHeight = getUsedHeight(p);
    if (pageUsedHeight > USABLE_HEIGHT + 2) {
      console.error("PAGE " + (i+1) + " USED HEIGHT: " + pageUsedHeight + " LAST CHILD CLASS: " + (p.lastElementChild ? p.lastElementChild.className : 'none') + " HTML: " + p.innerHTML.substring(0, 1000));

      const errorMsg = `خطأ في أبعاد الصفحة رقم ${i + 1}: الارتفاع المستخدم (${Math.round(pageUsedHeight)}px) يتجاوز الحد القابل للطباعة (${USABLE_HEIGHT}px). تم إيقاف التصدير.`;
      if (typeof window !== 'undefined') {
        alert(errorMsg);
      }
      throw new Error(errorMsg);
    }
  }

  // 7. Render to PDF
    const pdfOrientation = isLandscape ? 'landscape' : 'portrait';
    const pdf = new jsPDF({
      orientation: pdfOrientation,
      unit: 'mm',
      format: 'a4'
    });

    const pdfWidth = pdf.internal.pageSize.getWidth();
    const margin = 10;
    const printWidth = pdfWidth - (margin * 2);

    for (let i = 0; i < allPages.length; i++) {
      if (i > 0) {
        pdf.addPage();
      }
      const pageEl = allPages[i];
      const canvas = await html2canvas(pageEl, {
        window: iframe.contentWindow as unknown as Window,
        scale: HTML2CANVAS_SCALE,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff'
      } as any);

      const imgData = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      let finalPrintWidth = printWidth;
      let finalPrintHeight = (canvas.height * printWidth) / canvas.width;
      
      const pdfHeight = pdf.internal.pageSize.getHeight();
      const maxPrintHeight = pdfHeight - (margin * 2);

      if (finalPrintHeight > maxPrintHeight) {
        const ratio = maxPrintHeight / finalPrintHeight;
        finalPrintHeight = maxPrintHeight;
        finalPrintWidth = printWidth * ratio;
      }
      
      const xOffset = margin + (printWidth - finalPrintWidth) / 2;
      pdf.addImage(imgData, 'JPEG', xOffset, margin, finalPrintWidth, finalPrintHeight);
    }

    pdf.save(data.filename);

  } catch (err) {
    console.error("PDF Export caught error:", err);
    throw err;
  } finally {
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  }
}
