import { prisma } from "../../common/prisma";
import { NotFoundError, ForbiddenError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { notificationsService } from "../notifications/notifications.service";

type CommentEntityType = "PAYMENT" | "TRANSFER";

// Confirms the payment/transfer actually belongs to this tenant before
// anyone can read or post into its comment thread - entityId alone isn't
// enough, it must resolve inside the caller's own tenant.
async function assertEntityInTenant(tenantId: string, entityType: CommentEntityType, entityId: string): Promise<string> {
  if (entityType === "PAYMENT") {
    const payment = await prisma.payment.findFirst({ where: { id: entityId, tenantId, deletedAt: null }, select: { paymentNumber: true } });
    if (!payment) throw new NotFoundError("Payment not found");
    return `Payment ${payment.paymentNumber}`;
  }
  const transfer = await prisma.transfer.findFirst({ where: { id: entityId, tenantId }, select: { transferNumber: true } });
  if (!transfer) throw new NotFoundError("Transfer not found");
  return `Transfer ${transfer.transferNumber}`;
}

function serialize(comment: any) {
  return {
    id: comment.id,
    entityType: comment.entityType,
    entityId: comment.entityId,
    body: comment.body,
    mentionedUserIds: (comment.mentions ?? []).map((m: any) => m.userId as string),
    author: comment.author,
    createdAt: comment.createdAt,
  };
}

const commentInclude = { author: { select: { id: true, name: true, email: true } }, mentions: { select: { userId: true } } };

export const commentsService = {
  // For the @mention autocomplete - deliberately not gated by USERS_MANAGE
  // (that's for the Administration > Users CRUD screen) since any tenant
  // user who can see a comment thread should be able to @mention a
  // colleague in it. Only id/name/email, nothing sensitive.
  async mentionableUsers(tenantId: string) {
    return prisma.user.findMany({
      where: { tenantId, status: "ACTIVE", deletedAt: null },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    });
  },

  async list(tenantId: string, entityType: CommentEntityType, entityId: string) {
    await assertEntityInTenant(tenantId, entityType, entityId);
    const rows = await prisma.comment.findMany({
      where: { tenantId, entityType, entityId },
      include: commentInclude,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(serialize);
  },

  async create(tenantId: string, actorId: string, input: { entityType: CommentEntityType; entityId: string; body: string; mentionedUserIds?: string[] }) {
    const label = await assertEntityInTenant(tenantId, input.entityType, input.entityId);

    // Only notify mentions that actually resolve to a real, active user in
    // this tenant - the frontend's autocomplete should only ever offer
    // those, but the mentionedUserIds array is client-supplied, so it's
    // re-validated here rather than trusted as-is.
    const validMentions = input.mentionedUserIds?.length
      ? await prisma.user.findMany({ where: { id: { in: input.mentionedUserIds }, tenantId, status: "ACTIVE", deletedAt: null }, select: { id: true } })
      : [];
    const mentionedUserIds = validMentions.map((u) => u.id);

    const comment = await prisma.comment.create({
      data: {
        tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        authorId: actorId,
        body: input.body,
        mentions: mentionedUserIds.length ? { create: mentionedUserIds.map((userId) => ({ userId })) } : undefined,
      },
      include: commentInclude,
    });

    const notifyIds = mentionedUserIds.filter((id) => id !== actorId);
    if (notifyIds.length > 0) {
      await notificationsService.notifyMany(tenantId, notifyIds, {
        title: "You were mentioned in a comment",
        message: `${comment.author.name} mentioned you on ${label}: "${input.body.slice(0, 140)}${input.body.length > 140 ? "…" : ""}"`,
        type: "INFO",
        relatedEntityType: input.entityType,
        relatedEntityId: input.entityId,
      });
    }

    await auditService.record({ tenantId, actorId, action: "comment.create", entityType: input.entityType, entityId: input.entityId, afterState: { commentId: comment.id } });
    return serialize(comment);
  },

  async remove(tenantId: string, actorId: string, id: string, isPrivileged: boolean) {
    const comment = await prisma.comment.findFirst({ where: { id, tenantId } });
    if (!comment) throw new NotFoundError("Comment not found");
    if (!isPrivileged && comment.authorId !== actorId) {
      throw new ForbiddenError("You can only delete your own comments");
    }
    await prisma.comment.delete({ where: { id } });
    await auditService.record({ tenantId, actorId, action: "comment.delete", entityType: comment.entityType, entityId: comment.entityId, beforeState: { commentId: id } });
    return { deleted: true };
  },
};
