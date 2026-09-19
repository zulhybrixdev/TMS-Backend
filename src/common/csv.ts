// Common Service: minimal CSV serialiser used by the Reports module.
// Opens cleanly in Excel; a true binary .xlsx/.pdf renderer is out of scope
// for Phase 1 (see README "Assumptions").

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeCell(c.header)).join(",");
  const lines = rows.map((row) =>
    columns.map((c) => escapeCell(c.value(row))).join(",")
  );
  return [header, ...lines].join("\r\n");
}
