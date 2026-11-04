// Local Arabic print and searchable text PDF; all user content stays text.

import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';

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

const escapePrintText = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]!));

// Preserve the fixed inline badges used by existing reports. Everything else is text.
const safePrintCell = (value: string): string => {
  const badge = /^<span style="([a-zA-Z0-9#%;:.,() \-]+)">([^<>]*)<\/span>$/.exec(String(value));
  const style = badge?.[1];
  const allowed = /^(display|padding|background-color|color|font-weight|border-radius|font-size)$/;
  if (badge && style?.split(';').every(rule => !rule.trim() || (
    allowed.test(rule.trim().split(':')[0]) && !/url|expression|var\(/i.test(rule)
  ))) return `<span style="${style}">${escapePrintText(badge[2])}</span>`;
  return escapePrintText(value);
};

const safePrintData = (data: PrintData): PrintData => ({
  ...data,
  title: escapePrintText(data.title),
  organizationName: escapePrintText(data.organizationName),
  departmentName: escapePrintText(data.departmentName),
  metaFields: data.metaFields.map(field => ({ label: escapePrintText(field.label), value: escapePrintText(field.value) })),
  tables: data.tables.map(table => ({
    ...table, title: table.title && escapePrintText(table.title),
    headers: table.headers.map(escapePrintText),
    rows: table.rows.map(row => row.map((cell, index) =>
      ['الرصيد الفعلي', 'الرصيد', 'العجز', 'الأيام المتبقية', 'نوع الحركة', 'نظام الحركة', 'أصناف حرجة', 'الكمية بعد الحركة', 'مقدار الرصيد الدفتري والميداني'].includes(table.headers[index])
        ? safePrintCell(cell) : escapePrintText(cell),
    )),
    columnAlignments: table.columnAlignments?.map(align => ['right', 'center', 'left'].includes(align) ? align : 'right'),
    rowBgColors: table.rowBgColors?.map(color => color && /^(#[a-fA-F0-9]{3,8}|[a-zA-Z]+)$/.test(color) ? color : null),
  })),
  notes: data.notes && escapePrintText(data.notes),
  barcode: data.barcode && escapePrintText(data.barcode),
  signatures: data.signatures?.map(sig => typeof sig === 'string' ? escapePrintText(sig) : ({
    ...sig, role: escapePrintText(sig.role), name: escapePrintText(sig.name),
  })),
});

export function printHtml(data: PrintData) {
  data = safePrintData(data);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
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
        <div class="barcode-lines">${data.barcode}</div>
        <div class="barcode-text">رقم السند ${data.barcode}</div>
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

let cairoFont: Promise<string> | null = null;
const loadCairoFont = (): Promise<string> => {
  if (!cairoFont) {
    cairoFont = fetch(new URL('Cairo-Regular.ttf', document.baseURI).href).then(async response => {
      if (!response.ok) throw new Error('تعذر تحميل الخط العربي المحلي. أعد المحاولة عند استقرار الاتصال.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return btoa(binary);
    }).catch(error => { cairoFont = null; throw error; });
  }
  return cairoFont;
};
const badgeColumns = new Set(['الرصيد الفعلي', 'الرصيد', 'العجز', 'الأيام المتبقية', 'نوع الحركة', 'نظام الحركة', 'أصناف حرجة', 'الكمية بعد الحركة', 'مقدار الرصيد الدفتري والميداني']);
const plainCell = (cell: string, header: string): string => {
  // Only the fixed, already validated badge columns may contain application markup.
  if (badgeColumns.has(header) && safePrintCell(cell).startsWith('<span style="')) {
    return /^<span style="[^"]+">([^<>]*)<\/span>$/.exec(cell)?.[1] || String(cell);
  }
  return String(cell ?? '');
};

export async function buildTextPDF(data: PrintData & { orientation?: 'portrait' | 'landscape' }): Promise<jsPDF> {
  if (!Array.isArray(data.tables)) throw new Error('جداول التقرير غير صالحة.');
  data.tables.forEach((table, tableIndex) => {
    if (!Array.isArray(table.recordIds) || table.recordIds.length !== table.rows.length) throw new Error(`الجدول ${tableIndex}: هوية الصفوف لا تطابق البيانات.`);
    const ids = table.recordIds.map(id => requireStableStringPart(id, `table-${tableIndex}`));
    if (new Set(ids).size !== ids.length) throw new Error(`الجدول ${tableIndex}: هوية صف مكررة.`);
    if (table.rows.some(row => row.length !== table.headers.length)) throw new Error(`الجدول ${tableIndex}: عدد الخلايا لا يطابق الأعمدة.`);
  });
  const pdf = new jsPDF({ orientation: data.orientation || 'portrait', format: 'a4', unit: 'mm', compress: true });
  pdf.addFileToVFS('InventoryCairo.ttf', await loadCairoFont());
  pdf.addFont('InventoryCairo.ttf', 'InventoryCairo', 'normal');
  pdf.setFont('InventoryCairo', 'normal');
  pdf.setR2L(false);
  // jsPDF's R2L flag reverses Latin codes too. Its bidi options preserve logical
  // Arabic and embedded LTR numbers/codes, including AutoTable's text calls.
  const writeText = pdf.text.bind(pdf);
  pdf.text = ((text: string | string[], x: number, y: number, options = {}) => writeText(text, x, y, {
    ...options, isInputVisual: false, isInputRtl: true, isOutputVisual: true, isOutputRtl: false,
  } as Parameters<typeof pdf.text>[3])) as typeof pdf.text;
  pdf.setProperties({ title: data.title, subject: data.organizationName, creator: 'Inventory application' });
  const margin = 12, width = pdf.internal.pageSize.getWidth(), height = pdf.internal.pageSize.getHeight();
  const usable = width - margin * 2;
  const headerBlocks = [data.organizationName, data.departmentName, data.title].map((value, index) => {
    pdf.setFontSize(index === 2 ? 12 : 10);
    return { lines: pdf.splitTextToSize(String(value || ''), usable), size: index === 2 ? 12 : 10 };
  });
  const headerHeight = margin + headerBlocks.reduce((sum, block) => sum + block.lines.length * 5 + 2, 0) + 4;
  if (headerHeight > height / 2) throw new Error('عنوان التقرير أطول من المساحة المتاحة للصفحة.');
  const headerPages = new Set<number>();
  const drawHeader = () => {
    const page = pdf.getCurrentPageInfo().pageNumber;
    if (headerPages.has(page)) return;
    headerPages.add(page);
    let top = margin;
    pdf.setTextColor('#173f63');
    for (const block of headerBlocks) {
      pdf.setFontSize(block.size);
      for (const line of block.lines) { pdf.text(line, width - margin, top, { align: 'right' }); top += 5; }
      top += 2;
    }
    pdf.setDrawColor('#007ab7'); pdf.line(margin, headerHeight - 3, width - margin, headerHeight - 3);
    pdf.setTextColor('#172435'); pdf.setFontSize(9);
  };
  drawHeader(); let y = headerHeight + 3;
  const nextPage = () => { pdf.addPage(); drawHeader(); y = headerHeight + 3; };
  const block = (value: string, size = 9) => {
    pdf.setFontSize(size);
    for (const line of pdf.splitTextToSize(String(value || ''), usable)) {
      if (y + 5 > height - 14) nextPage();
      pdf.text(line, width - margin, y, { align: 'right' }); y += 5;
    }
    y += 2;
  };
  for (const field of data.metaFields || []) block(`${field.label} ${field.value || '-'}`);
  let renderedRows = 0;
  for (const table of data.tables) {
    if (table.title) block(table.title, 10);
    if (table.rows.length === 0) block('لا توجد سجلات تطابق المرشحات الحالية.');
    const rows = table.rows.map(row => row.map((cell, index) => plainCell(cell, table.headers[index])).reverse());
    autoTable(pdf, {
      startY: y, margin: { top: headerHeight + 2, right: margin, left: margin, bottom: 15 },
      head: [[...table.headers].reverse()], body: rows,
      styles: { font: 'InventoryCairo', fontStyle: 'normal', fontSize: 9, minCellWidth: 15, cellPadding: 2, overflow: 'linebreak', halign: 'right', valign: 'middle', lineColor: '#d9e2ec', lineWidth: 0.15 },
      headStyles: { fillColor: '#007ab7', textColor: '#ffffff', fontStyle: 'normal', halign: 'center' },
      columnStyles: Object.fromEntries([...table.headers].reverse().map((header, index) => [index, { minCellWidth: /التصنيف|كود|مستودع|التخزين/.test(header) ? 23 : 15 }])),
      alternateRowStyles: { fillColor: '#f4f8fb' }, rowPageBreak: 'avoid', showHead: 'everyPage',
      didParseCell: hook => {
        if (hook.section !== 'body') return;
        const originalColumn = table.headers.length - 1 - hook.column.index;
        hook.cell.styles.halign = table.columnAlignments?.[originalColumn] || 'right';
        const color = table.rowBgColors?.[hook.row.index];
        if (color && /^#[a-fA-F0-9]{6}$/.test(color)) hook.cell.styles.fillColor = color;
      },
      willDrawCell: hook => {
        if (hook.section === 'body' && (hook.row.spansMultiplePages || hook.row.height > height - headerHeight - 28)) throw new Error('أحد سجلات التقرير أطول من صفحة؛ لم يُنزّل ملف مبتور.');
      },
      didDrawCell: hook => { if (hook.section === 'body' && hook.column.index === 0) renderedRows++; },
      didDrawPage: drawHeader,
    });
    y = (pdf as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 7;
  }
  if (renderedRows !== data.tables.reduce((sum, table) => sum + table.rows.length, 0)) throw new Error('عدد صفوف PDF لا يطابق المصدر؛ لم يُنزّل الملف.');
  if (data.notes) block(`ملاحظات: ${data.notes}`);
  if (data.barcode) block(`رقم السند: ${data.barcode}`);
  const signatures = (data.signatures || []).filter(sig => typeof sig === 'string' || sig.show !== false);
  for (let offset = 0; offset < signatures.length; offset += 3) {
    const group = signatures.slice(offset, offset + 3);
    pdf.setFontSize(9);
    const columnWidth = usable / 3;
    const lines = group.map(sig => pdf.splitTextToSize(typeof sig === 'string' ? sig : `${sig.role}\n${sig.name || ''}`, columnWidth - 5));
    const blockHeight = Math.max(...lines.map(line => line.length * 5)) + 12;
    if (y + blockHeight > height - 14) nextPage();
    group.forEach((_, index) => {
      const right = width - margin - columnWidth * index;
      pdf.text(lines[index], right, y + 3, { align: 'right' });
      pdf.setDrawColor('#94a3b8'); pdf.line(right - columnWidth + 5, y + blockHeight - 4, right, y + blockHeight - 4);
    });
    y += blockHeight + 3;
  }
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page); pdf.setFontSize(8); pdf.setTextColor('#526276');
    pdf.text(`صفحة ${page} من ${pages}`, width / 2, height - 7, { align: 'center' });
  }
  return pdf;
}
export async function exportToPDF(data: PrintData & { filename: string; orientation?: 'portrait' | 'landscape' }) {
  const pdf = await buildTextPDF(data);
  pdf.save(data.filename);
}
