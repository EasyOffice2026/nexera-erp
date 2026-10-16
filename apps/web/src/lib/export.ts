const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

// Turns a rendered report table into an Excel file. Amounts (marked by data-amount) stay
// numbers with three decimals; merged headings stay merged.
export async function exportTableToExcel(
  table: HTMLTableElement,
  title: string,
  fileName: string,
  rightToLeft: boolean,
) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report', { views: [{ rightToLeft }] });
  sheet.getCell(1, 1).value = title;
  sheet.getCell(1, 1).font = { bold: true, size: 14 };

  const covered = new Set<string>();
  const widths: number[] = [];
  let r = 3;
  for (const row of Array.from(table.rows)) {
    let c = 1;
    for (const cell of Array.from(row.cells)) {
      while (covered.has(`${r}:${c}`)) c++;
      const target = sheet.getCell(r, c);
      const amount = cell.querySelector<HTMLElement>('[data-amount]')?.dataset.amount;
      const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (amount !== undefined) {
        target.value = Number(amount);
        target.numFmt = '#,##0.000;-#,##0.000';
      } else {
        target.value = text;
      }
      const strong =
        cell.tagName === 'TH' ||
        cell.closest('tfoot') !== null ||
        /font-(semibold|bold)/.test(`${cell.className} ${row.className}`);
      if (strong) target.font = { bold: true };
      if (cell.colSpan > 1 || cell.rowSpan > 1) {
        sheet.mergeCells(r, c, r + cell.rowSpan - 1, c + cell.colSpan - 1);
        for (let dr = 0; dr < cell.rowSpan; dr++) {
          for (let dc = 0; dc < cell.colSpan; dc++) covered.add(`${r + dr}:${c + dc}`);
        }
      } else {
        widths[c] = Math.max(widths[c] ?? 10, Math.min(60, text.length + 2));
      }
      c += cell.colSpan;
    }
    r++;
  }
  widths.forEach((width, index) => {
    if (width) sheet.getColumn(index).width = width;
  });
  const buffer = await workbook.xlsx.writeBuffer();
  download(new Blob([buffer], { type: XLSX_TYPE }), fileName);
}
