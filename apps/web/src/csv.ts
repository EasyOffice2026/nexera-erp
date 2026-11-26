export function downloadCsv(name: string, headings: string[], rows: string[][]) {
  const quote = (value: string) => {
    const safe = /^[\s]*[=+\-@\t\r\n]/.test(value) ? "'" + value : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const csv = [headings, ...rows].map((row) => row.map(quote).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
