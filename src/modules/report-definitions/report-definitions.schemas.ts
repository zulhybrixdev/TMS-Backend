import { z } from "zod";
import { BASE_REPORTS } from "../reports/reports.service";

const baseReportKeys = Object.keys(BASE_REPORTS) as [string, ...string[]];

export const createReportDefinitionSchema = z.object({
  name: z.string().min(2).max(100),
  baseReport: z.enum(baseReportKeys),
  columns: z.array(z.string()).min(1),
});
