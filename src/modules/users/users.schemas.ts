import { z } from "zod";

export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  jobTitle: z.string().optional(),
  department: z.string().optional(),
  password: z.string().min(8),
  roleIds: z.array(z.string()).min(1, "At least one role is required"),
});

export const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  jobTitle: z.string().optional(),
  department: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "LOCKED"]).optional(),
  roleIds: z.array(z.string()).optional(),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(8),
});

export const listUsersQuerySchema = z.object({
  page: z.string().optional(),
  pageSize: z.string().optional(),
  sortBy: z.string().optional(),
  sortDir: z.string().optional(),
  search: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "LOCKED"]).optional(),
  roleId: z.string().optional(),
});
