import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

export interface ExcelExportData {
  title: string;
  organizationName: string;
  departmentName: string;
  filename: string;
  metaFields: { label: string; value: string }[];
  headers: string[];
  rows: string[][];
  signatures?: { role: string; name: string; show?: boolean }[];
}

/**
 * Utility to export tables to a clean, Arabic-optimized, and RTL styled Excel spreadsheet.
 * Uses ExcelJS to provide identical professional styling and colors as the Reports tab.
 */
export async function exportToExcel(data: ExcelExportData): Promise<void> {
  const fontName = 'Segoe UI';

  // 1. Initialize Workbook & sheet with proper RTL view options
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('تقرير البيانات', {
    views: [{ showGridLines: true, rightToLeft: true }]
  });

  // 2. Format Sheet Header block beautifully and Arabized
  const orgLabel = data.organizationName || 'المستودع البلدي العام';
  const depLabel = data.departmentName || 'قسم الصحة والبيئة ومكافحة الأوبئة';
  const timeLabel = `تاريخ التصدير: ${new Date().toLocaleDateString('ar-EG')}`;

  const row1 = worksheet.addRow([orgLabel, '', '']);
  row1.getCell(1).font = { name: fontName, size: 11, bold: true, color: { argb: '007AB7' } }; // Theme Blue
  row1.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
  
  const row2 = worksheet.addRow([depLabel, '', '']);
  row2.getCell(1).font = { name: fontName, size: 10, bold: true, color: { argb: '475569' } };
  row2.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };

  // Determine standard right-to-left layout alignment
  const maxCols = Math.max(7, data.headers.length);
  
  // Set date text in the far columns
  row2.getCell(maxCols).value = timeLabel;
  row2.getCell(maxCols).font = { name: fontName, size: 10, color: { argb: '475569' } };
  row2.getCell(maxCols).alignment = { horizontal: 'left', vertical: 'middle' };

  // Merges for the headers
  worksheet.mergeCells(1, 1, 1, 3);
  worksheet.mergeCells(2, 1, 2, 3);
  worksheet.mergeCells(2, 4, 2, maxCols);

  worksheet.addRow([]); // Blank spacer

  // 3. Merged Title Row
  const titleRow = worksheet.addRow([data.title]);
  titleRow.height = 35;
  const titleRowIdx = titleRow.number;
  worksheet.mergeCells(titleRowIdx, 1, titleRowIdx, data.headers.length);
  
  const titleCell = titleRow.getCell(1);
  titleCell.font = { name: fontName, size: 16, bold: true, color: { argb: '0F172A' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'F1F5F9' } // Light gray background
  };
  
  worksheet.addRow([]); // Blank spacer

  // 4. Meta Information Fields
  data.metaFields.forEach(field => {
    const metaRow = worksheet.addRow([`${field.label} ${field.value}`]);
    const mIdx = metaRow.number;
    metaRow.getCell(1).font = { name: fontName, size: 10, bold: true, color: { argb: '475569' } };
    metaRow.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
    worksheet.mergeCells(mIdx, 1, mIdx, data.headers.length);
  });

  worksheet.addRow([]); // Blank spacer

  // 5. Header Row
  const headerRow = worksheet.addRow(data.headers);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.font = { name: fontName, size: 11, bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: '007AB7' } // UNRWA Blue
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: '94A3B8' } },
      bottom: { style: 'medium', color: { argb: '00557F' } },
      left: { style: 'thin', color: { argb: '94A3B8' } },
      right: { style: 'thin', color: { argb: '94A3B8' } }
    };
  });

  // Helper indexes for conditional formatting (Materials stock checking)
  const minStockColIdx = data.headers.findIndex(h => h.includes('الحد الأدنى') || h.includes('حد الأمان'));
  const currentStockColIdx = data.headers.findIndex(h => h.includes('الرصيد الفعلي') || h.includes('الرصيد الحالي') || h.includes('الكمية الحالية'));
  
  // Helper indexes for conditional formatting (Transaction type checking)
  const txTypeColIdx = data.headers.findIndex(h => h.includes('نظام الحركة') || h.includes('نوع الحركة') || h.includes('الحركة'));

  // 6. Data Rows
  data.rows.forEach((rowData, index) => {
    const processedRow = rowData.map(cell => {
      if (cell === null || cell === undefined) return '';
      // Parse clean numbers so they are actual numeric values in Excel
      const trimmed = String(cell).trim();
      if (trimmed !== '' && !isNaN(Number(trimmed))) {
        return Number(trimmed);
      }
      return cell;
    });

    const addedRow = worksheet.addRow(processedRow);
    addedRow.height = 24;
    const isAlternate = index % 2 === 1;

    addedRow.eachCell((cell) => {
      
      cell.font = { name: fontName, size: 10, color: { argb: '0F172A' } };
      cell.alignment = { 
        horizontal: 'center', 
        vertical: 'middle' 
      };
      
      cell.border = {
        top: { style: 'thin', color: { argb: 'E2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'E2E8F0' } },
        left: { style: 'thin', color: { argb: 'E2E8F0' } },
        right: { style: 'thin', color: { argb: 'E2E8F0' } }
      };

      if (isAlternate) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'F8FAFC' } // light alternate row
        };
      }
    });

    // A. Apply stock level conditional formatting (same as Reports.tsx)
    if (minStockColIdx !== -1 && currentStockColIdx !== -1) {
      const minStockVal = Number(addedRow.getCell(minStockColIdx + 1).value) || 0;
      const currentStockCell = addedRow.getCell(currentStockColIdx + 1);
      const currentStockVal = Number(currentStockCell.value) || 0;
      
      currentStockCell.font = { name: fontName, size: 10, bold: true };
      if (currentStockVal === 0) {
        currentStockCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } }; // Red alert
        currentStockCell.font = { name: fontName, size: 10, bold: true, color: { argb: '991B1B' } };
      } else if (currentStockVal <= minStockVal) {
        currentStockCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF3C7' } }; // Amber alert
        currentStockCell.font = { name: fontName, size: 10, bold: true, color: { argb: '92400E' } };
      } else {
        currentStockCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0F2FE' } }; // Blue safe
        currentStockCell.font = { name: fontName, size: 10, bold: true, color: { argb: '00557F' } };
      }
    }

    // B. Apply transaction type conditional formatting (same as Reports.tsx)
    if (txTypeColIdx !== -1) {
      const cell = addedRow.getCell(txTypeColIdx + 1);
      const textVal = String(cell.value || '');
      cell.font = { name: fontName, size: 10, bold: true };
      if (textVal.includes('وارد') || textVal.includes('إدخال') || textVal.includes('إضافة')) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0F2FE' } }; // Light blue
        cell.font = { name: fontName, size: 10, bold: true, color: { argb: '00557F' } };
      } else if (textVal.includes('صادر') || textVal.includes('صرف') || textVal.includes('إخراج')) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } }; // Light red
        cell.font = { name: fontName, size: 10, bold: true, color: { argb: '991B1B' } };
      } else {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF3C7' } }; // Light amber
        cell.font = { name: fontName, size: 10, bold: true, color: { argb: '92400E' } };
      }
    }
  });

  worksheet.addRow([]); // Spacer
  worksheet.addRow([]); // Spacer

  // 7. Signature blocks at the bottom
  if (data.signatures && data.signatures.length > 0) {
    const sigRow = worksheet.addRow([]);
    sigRow.height = 30;
    
    const numCols = data.headers.length;
    const numSigs = data.signatures.length;
    
    if (numSigs === 3 && numCols >= 6) {
      const colLeft = 1;
      const colCenter = Math.floor(numCols / 2) + 1;
      const colRight = numCols;
      
      if (data.signatures[0].show !== false) {
        sigRow.getCell(colLeft).value = `${data.signatures[0].role}: ${data.signatures[0].name}`;
        sigRow.getCell(colLeft).font = { name: fontName, size: 10, bold: true, color: { argb: '475569' } };
        sigRow.getCell(colLeft).alignment = { horizontal: 'right', vertical: 'middle' };
      }
      
      if (data.signatures[1].show !== false) {
        sigRow.getCell(colCenter).value = `${data.signatures[1].role}: ${data.signatures[1].name}`;
        sigRow.getCell(colCenter).font = { name: fontName, size: 10, bold: true, color: { argb: '475569' } };
        sigRow.getCell(colCenter).alignment = { horizontal: 'center', vertical: 'middle' };
      }
      
      if (data.signatures[2].show !== false) {
        sigRow.getCell(colRight).value = `${data.signatures[2].role}: ${data.signatures[2].name}`;
        sigRow.getCell(colRight).font = { name: fontName, size: 10, bold: true, color: { argb: '475569' } };
        sigRow.getCell(colRight).alignment = { horizontal: 'left', vertical: 'middle' };
      }
    } else {
      const sigText = data.signatures
        .filter(s => s.show !== false)
        .map(s => `${s.role}: ${s.name}`)
        .join('   |   ');
      if (sigText) {
        const fullSigRow = worksheet.addRow([sigText]);
        fullSigRow.getCell(1).font = { name: fontName, size: 10, bold: true, color: { argb: '475569' } };
        fullSigRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
        worksheet.mergeCells(fullSigRow.number, 1, fullSigRow.number, numCols);
      }
    }
  }

  // 8. Automatic sizing of columns
  data.headers.forEach((h, colIdx) => {
    const column = worksheet.getColumn(colIdx + 1);
    let maxLen = h.length;
    
    for (let r = headerRow.number; r <= headerRow.number + data.rows.length; r++) {
      const val = worksheet.getRow(r).getCell(colIdx + 1).value;
      if (val !== undefined && val !== null) {
        const strLen = String(val).length;
        if (strLen > maxLen) {
          maxLen = strLen;
        }
      }
    }
    
    column.width = Math.max(maxLen + 4, 15);
  });

  // 9. Generate the Excel binary stream and trigger download
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, data.filename);
}
