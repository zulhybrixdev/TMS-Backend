import { z } from "zod";

export const createRoleSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  permissionCodes: z.array(z.string()).default([]),
});

export const updateRoleSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().optional(),
  permissionCodes: z.array(z.string()).optional(),
});
