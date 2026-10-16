// Reads a bank statement file (Excel .xlsx or CSV) into rows of text for the column mapping.

function detectDelimiter(text: string): string {
  const firstLines = text.split(/\r?\n/).slice(0, 10).join('\n');
  const counts = [',', ';', '\t'].map((d) => [d, firstLines.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const object = value as {
      richText?: { text: string }[];
      result?: unknown;
      text?: unknown;
      error?: string;
    };
    if (object.richText) return object.richText.map((part) => part.text).join('');
    if ('result' in object) return cellText(object.result);
    if ('text' in object) return cellText(object.text);
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value === 'string' ? value : '';
}

export async function readStatementFile(file: File): Promise<string[][]> {
  if (/\.csv$|\.txt$/i.test(file.name)) return parseCsv(await file.text());
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, number) => {
    const values: string[] = [];
    for (let c = 1; c <= Math.min(row.cellCount, 60); c++)
      values.push(cellText(row.getCell(c).value).trim());
    rows[number - 1] = values;
  });
  return Array.from(rows, (row) => row ?? []);
}
