import { prisma } from "../../common/prisma";
import { NotificationType } from "@prisma/client";

export interface CreateNotificationInput {
  tenantId: string;
  userId: string;
  title: string;
  message: string;
  type?: NotificationType;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

// Common Service: in-app notifications. Phase 1 stores notifications for
// display in the UI (bell icon / toast on next fetch). Email/SMS delivery
// can be added later behind this same interface without touching callers.
export const notificationsService = {
  async notify(input: CreateNotificationInput) {
    return prisma.notification.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        title: input.title,
        message: input.message,
        type: input.type ?? "INFO",
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
      },
    });
  },

  async notifyMany(tenantId: string, userIds: string[], input: Omit<CreateNotificationInput, "userId" | "tenantId">) {
    if (userIds.length === 0) return;
    await prisma.notification.createMany({
      data: userIds.map((userId) => ({
        tenantId,
        userId,
        title: input.title,
        message: input.message,
        type: input.type ?? "INFO",
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
      })),
    });
  },

  async listForUser(tenantId: string, userId: string, unreadOnly: boolean) {
    return prisma.notification.findMany({
      where: { tenantId, userId, ...(unreadOnly ? { isRead: false } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  },

  async markRead(tenantId: string, userId: string, id: string) {
    return prisma.notification.updateMany({
      where: { id, tenantId, userId },
      data: { isRead: true },
    });
  },

  async markAllRead(tenantId: string, userId: string) {
    await prisma.notification.updateMany({
      where: { tenantId, userId, isRead: false },
      data: { isRead: true },
    });
  },
};
