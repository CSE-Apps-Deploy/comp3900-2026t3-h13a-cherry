const fs = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { CHAT_ATTACHMENT_DIR } = require('../middleware/upload');
const { getSocketIO } = require('../services/socketService');

const messagePublicOmit = {
  attachmentStorageKey: true,
};

const conversationInclude = {
  participants: {
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true, avatar: true, role: true },
      },
    },
  },
  messages: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    omit: messagePublicOmit,
    include: {
      sender: { select: { id: true, firstName: true, lastName: true } },
    },
  },
};

const isAdminRole = (role) => role === 'ADMIN' || role === 'SYSTEM_ADMIN';

const findAvailableAdmin = async () => {
  const admins = await prisma.user.findMany({
    where: {
      role: { in: ['ADMIN', 'SYSTEM_ADMIN'] },
      status: 'ACTIVE',
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  if (admins.length === 0) {
    return null;
  }

  const adminIds = admins.map((admin) => admin.id);
  const openSupportConversations = await prisma.conversation.findMany({
    where: {
      type: 'SUPPORT',
      status: 'OPEN',
      supportAssignedAdminId: { in: adminIds },
    },
    select: { supportAssignedAdminId: true },
  });

  const openCounts = openSupportConversations.reduce((counts, conversation) => {
    const adminId = conversation.supportAssignedAdminId;
    if (!adminId) return counts;
    counts.set(adminId, (counts.get(adminId) || 0) + 1);
    return counts;
  }, new Map());

  return admins.reduce((best, admin) => {
    const bestCount = openCounts.get(best.id) || 0;
    const adminCount = openCounts.get(admin.id) || 0;
    return adminCount < bestCount ? admin : best;
  }, admins[0]);
};

const emitConversationClosed = (conversationId, payload) => {
  const io = getSocketIO();
  if (io) {
    io.to(`conversation:${conversationId}`).emit('conversation_closed', payload);
  }
};

exports.getConversations = async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    where: {
      participants: { some: { userId: req.user.id } },
    },
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true, avatar: true, role: true },
          },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        omit: messagePublicOmit,
        include: {
          sender: { select: { id: true, firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const conversationsWithUnread = await Promise.all(
    conversations.map(async (conversation) => {
      const myParticipant = conversation.participants.find((item) => item.userId === req.user.id);
      const where = {
        conversationId: conversation.id,
        senderId: { not: req.user.id },
        ...(myParticipant?.lastReadAt ? { createdAt: { gt: myParticipant.lastReadAt } } : {}),
      };

      const unreadCount = await prisma.message.count({ where });

      return {
        ...conversation,
        lastMessage: conversation.messages[0] || null,
        unreadCount,
      };
    })
  );

  res.json({ success: true, data: { conversations: conversationsWithUnread } });
};

exports.createOrGetConversation = async (req, res) => {
  const userId = req.body.userId || req.body.participantId;

  if (!userId) throw new AppError('User ID required', 400);
  if (userId === req.user.id) throw new AppError('Cannot message yourself', 400);

  const targetUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!targetUser) throw new AppError('User not found', 404);

  const existing = await prisma.conversation.findFirst({
    where: {
      AND: [
        { type: 'DIRECT' },
        { participants: { some: { userId: req.user.id } } },
        { participants: { some: { userId } } },
      ],
    },
    include: conversationInclude,
  });

  if (existing) {
    return res.json({
      success: true,
      data: {
        ...existing,
        lastMessage: existing.messages[0] || null,
      },
    });
  }

  const conversation = await prisma.conversation.create({
    data: {
      type: 'DIRECT',
      participants: {
        create: [{ userId: req.user.id }, { userId }],
      },
    },
    include: {
      participants: {
        include: {
          user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
        },
      },
      messages: true,
    },
  });

  res.status(201).json({ success: true, data: conversation });
};

exports.openSupportConversation = async (req, res) => {
  if (isAdminRole(req.user.role)) {
    throw new AppError('Administrators cannot initiate support conversations', 403);
  }

  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'SUPPORT',
      status: 'OPEN',
      supportRequesterId: req.user.id,
      participants: { some: { userId: req.user.id } },
    },
    include: conversationInclude,
  });

  if (existing) {
    return res.json({
      success: true,
      data: {
        ...existing,
        lastMessage: existing.messages[0] || null,
      },
    });
  }

  const admin = await findAvailableAdmin();

  if (!admin) {
    throw new AppError('No administrator is available right now', 404);
  }

  const conversation = await prisma.conversation.create({
    data: {
      type: 'SUPPORT',
      status: 'OPEN',
      supportRequesterId: req.user.id,
      supportAssignedAdminId: admin.id,
      participants: {
        create: [{ userId: req.user.id }, { userId: admin.id }],
      },
    },
    include: conversationInclude,
  });

  res.status(201).json({
    success: true,
    data: {
      ...conversation,
      lastMessage: conversation.messages[0] || null,
    },
  });
};

exports.getConversationMessages = async (req, res) => {
  const { conversationId } = req.params;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: req.user.id } },
  });

  if (!participant) throw new AppError('Conversation not found', 404);

  const skip = (page - 1) * limit;
  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId },
      omit: messagePublicOmit,
      include: {
        sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.message.count({ where: { conversationId } }),
  ]);

  res.json({
    success: true,
    data: {
      messages: messages.reverse(),
      pagination: { page, limit, total },
    },
  });
};

exports.sendMessage = async (req, res) => {
  const { conversationId } = req.params;
  const content = String(req.body.content || '').trim();
  const attachment = req.file || null;
  let messagePersisted = false;

  if (!content && !attachment) {
    throw new AppError('Add a message or attachment before sending', 400);
  }

  try {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: req.user.id } },
      include: {
        conversation: {
          select: { status: true },
        },
      },
    });

    if (!participant) throw new AppError('Conversation not found', 404);
    if (participant.conversation?.status === 'CLOSED') {
      throw new AppError('This conversation is closed and read-only', 400);
    }

    const otherParticipant = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId: { not: req.user.id } },
    });

    if (!otherParticipant) throw new AppError('Conversation recipient not found', 404);

    const messageId = uuidv4();
    const message = await prisma.message.create({
      data: {
        id: messageId,
        conversationId,
        senderId: req.user.id,
        receiverId: otherParticipant.userId,
        content,
        status: 'SENT',
        ...(attachment
          ? {
              attachmentUrl: `/api/v1/messages/attachments/${messageId}`,
              attachmentType: attachment.mimetype,
              attachmentName: attachment.originalname,
              attachmentSize: attachment.size,
              attachmentStorageKey: attachment.filename,
            }
          : {}),
      },
      include: {
        sender: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
      omit: messagePublicOmit,
    });
    messagePersisted = true;

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    const io = getSocketIO();
    if (io) {
      io.to(`user:${otherParticipant.userId}`).emit('new_message', message);
      io.to(`conversation:${conversationId}`).emit('new_message', message);
    }

    res.status(201).json({ success: true, data: message });
  } catch (error) {
    if (attachment?.path && !messagePersisted) {
      await fs.unlink(attachment.path).catch(() => {});
    }
    throw error;
  }
};

exports.downloadAttachment = async (req, res) => {
  const message = await prisma.message.findUnique({
    where: { id: req.params.messageId },
    select: {
      conversationId: true,
      attachmentName: true,
      attachmentStorageKey: true,
    },
  });

  if (!message?.attachmentStorageKey) {
    throw new AppError('Attachment not found', 404);
  }

  const participant = await prisma.conversationParticipant.findUnique({
    where: {
      conversationId_userId: {
        conversationId: message.conversationId,
        userId: req.user.id,
      },
    },
  });

  if (!participant) throw new AppError('Attachment not found', 404);

  const storageKey = path.basename(message.attachmentStorageKey);
  if (storageKey !== message.attachmentStorageKey) {
    throw new AppError('Attachment not found', 404);
  }

  const filePath = path.resolve(CHAT_ATTACHMENT_DIR, storageKey);
  await fs.access(filePath).catch(() => {
    throw new AppError('Attachment file is unavailable', 404);
  });

  res.download(filePath, message.attachmentName || 'attachment');
};

exports.closeConversation = async (req, res) => {
  const { conversationId } = req.params;

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: req.user.id } },
    include: {
      conversation: {
        select: { id: true, type: true, status: true },
      },
    },
  });

  if (!participant || participant.conversation?.type !== 'SUPPORT') {
    throw new AppError('Conversation not found', 404);
  }

  const closedAt = new Date();
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data:
      participant.conversation.status === 'CLOSED'
        ? {}
        : {
            status: 'CLOSED',
            closedById: req.user.id,
            closedAt,
          },
    include: conversationInclude,
  });

  const payload = {
    conversationId,
    status: conversation.status,
    closedById: conversation.closedById,
    closedAt: conversation.closedAt,
  };

  emitConversationClosed(conversationId, payload);

  res.json({
    success: true,
    data: {
      ...conversation,
      lastMessage: conversation.messages[0] || null,
    },
  });
};

exports.markAsRead = async (req, res) => {
  const { conversationId } = req.params;

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: req.user.id } },
  });

  if (!participant) throw new AppError('Conversation not found', 404);

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId: req.user.id } },
    data: { lastReadAt: new Date() },
  });

  await prisma.message.updateMany({
    where: {
      conversationId,
      receiverId: req.user.id,
      status: { in: ['SENT', 'DELIVERED'] },
    },
    data: { status: 'READ' },
  });

  const io = getSocketIO();
  if (io) {
    io.to(`conversation:${conversationId}`).emit('messages_read', {
      conversationId,
      userId: req.user.id,
    });
  }

  res.json({ success: true, message: 'Messages marked as read' });
};

exports.getUnreadCount = async (req, res) => {
  const count = await prisma.message.count({
    where: {
      receiverId: req.user.id,
      status: { in: ['SENT', 'DELIVERED'] },
    },
  });

  res.json({ success: true, data: { count } });
};
