import ExcelJS from "exceljs";
import type { CsvColumn } from "./csv";

// Common Service: real binary .xlsx export, sharing the exact same column
// definitions (header + value getter) every report already builds for
// toCsv() - see reports.service.ts. Kept separate from csv.ts (sync,
// dependency-free) since this one is async and pulls in exceljs.
export async function toXlsxBuffer<T>(sheetName: string, rows: T[], columns: CsvColumn<T>[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Treasury System";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31)); // Excel's own 31-char sheet name limit
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.header, width: Math.max(12, c.header.length + 4) }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  for (const row of rows) {
    sheet.addRow(columns.map((c) => c.value(row) ?? ""));
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
