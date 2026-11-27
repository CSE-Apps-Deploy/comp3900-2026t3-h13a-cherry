const fs = require('fs/promises');
const path = require('path');
const request = require('supertest');

const prisma = {
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  conversation: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  conversationParticipant: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  message: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  notification: {
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  },
};

const ioEmit = vi.fn();
const ioMock = {
  to: vi.fn(() => ({ emit: ioEmit })),
};

const databaseModulePath = require.resolve('../../src/config/database');
const socketServiceModulePath = require.resolve('../../src/services/socketService');
const appModulePath = require.resolve('../../src/app');

delete require.cache[databaseModulePath];
delete require.cache[socketServiceModulePath];
delete require.cache[appModulePath];

require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: { prisma },
};

require.cache[socketServiceModulePath] = {
  id: socketServiceModulePath,
  filename: socketServiceModulePath,
  loaded: true,
  exports: {
    getSocketIO: () => ioMock,
    initSocket: vi.fn(),
  },
};

const app = require('../../src/app');
const { createAccessToken } = require('../../src/utils/tokens');

const learnerUser = {
  id: 'learner-1',
  email: 'learner@example.com',
  role: 'LEARNER',
  status: 'ACTIVE',
};

const otherUser = {
  id: 'tutor-1',
  email: 'tutor@example.com',
  role: 'TUTOR',
  status: 'ACTIVE',
};

const adminUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'ADMIN',
  status: 'ACTIVE',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('messages and notifications integration tests', () => {
  test('creates a new conversation with another user', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(learnerUser)
      .mockResolvedValueOnce(otherUser);
    prisma.conversation.findFirst.mockResolvedValueOnce(null);
    prisma.conversation.create.mockResolvedValueOnce({
      id: 'conversation-1',
      participants: [
        { userId: learnerUser.id, user: { id: learnerUser.id, firstName: 'Learner', lastName: 'One' } },
        { userId: otherUser.id, user: { id: otherUser.id, firstName: 'Tutor', lastName: 'Two' } },
      ],
      messages: [],
    });

    const response = await request(app)
      .post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ userId: otherUser.id });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.id).toBe('conversation-1');
  });

  test('opens a new support conversation with an available admin', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.conversation.findFirst.mockResolvedValueOnce(null);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'admin-busy' }, { id: adminUser.id }]);
    prisma.conversation.findMany.mockResolvedValueOnce([
      { supportAssignedAdminId: 'admin-busy' },
      { supportAssignedAdminId: 'admin-busy' },
    ]);
    prisma.conversation.create.mockResolvedValueOnce({
      id: 'support-conversation-1',
      type: 'SUPPORT',
      status: 'OPEN',
      supportRequesterId: learnerUser.id,
      supportAssignedAdminId: adminUser.id,
      participants: [
        { userId: learnerUser.id, user: { id: learnerUser.id, firstName: 'Learner', lastName: 'One' } },
        { userId: adminUser.id, user: { id: adminUser.id, firstName: 'Admin', lastName: 'User' } },
      ],
      messages: [],
    });

    const response = await request(app)
      .post('/api/v1/messages/support/open')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send();

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.type).toBe('SUPPORT');
    expect(response.body.data.supportAssignedAdminId).toBe(adminUser.id);
    expect(prisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'SUPPORT',
          status: 'OPEN',
          supportRequesterId: learnerUser.id,
          supportAssignedAdminId: adminUser.id,
        }),
      })
    );
  });

  test('reopens an existing open support conversation instead of creating another', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.conversation.findFirst.mockResolvedValueOnce({
      id: 'support-conversation-1',
      type: 'SUPPORT',
      status: 'OPEN',
      supportRequesterId: learnerUser.id,
      supportAssignedAdminId: adminUser.id,
      participants: [],
      messages: [{ id: 'message-1', content: 'Existing support request' }],
    });

    const response = await request(app)
      .post('/api/v1/messages/support/open')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.id).toBe('support-conversation-1');
    expect(response.body.data.lastMessage.content).toBe('Existing support request');
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  test('sends a message to the other conversation participant and emits socket events', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.conversationParticipant.findUnique.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      userId: learnerUser.id,
    });
    prisma.conversationParticipant.findFirst.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      userId: otherUser.id,
    });
    prisma.message.create.mockResolvedValueOnce({
      id: 'message-1',
      conversationId: 'conversation-1',
      senderId: learnerUser.id,
      receiverId: otherUser.id,
      content: 'Hello tutor',
      status: 'SENT',
      sender: {
        id: learnerUser.id,
        firstName: 'Learner',
        lastName: 'One',
        avatar: null,
      },
    });
    prisma.conversation.update.mockResolvedValueOnce({ id: 'conversation-1' });

    const response = await request(app)
      .post('/api/v1/messages/conversations/conversation-1')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ content: 'Hello tutor' });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.content).toBe('Hello tutor');
    expect(ioMock.to).toHaveBeenCalledWith(`user:${otherUser.id}`);
    expect(ioMock.to).toHaveBeenCalledWith('conversation:conversation-1');
    expect(ioEmit).toHaveBeenCalled();
  });

  test('sends a message with an attachment and records its metadata', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.conversationParticipant.findUnique.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      userId: learnerUser.id,
    });
    prisma.conversationParticipant.findFirst.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      userId: otherUser.id,
    });

    let storedAttachmentKey = '';
    prisma.message.create.mockImplementationOnce(async ({ data }) => {
      storedAttachmentKey = data.attachmentStorageKey;
      const { attachmentStorageKey: _attachmentStorageKey, ...publicData } = data;
      return {
        ...publicData,
        sender: {
          id: learnerUser.id,
          firstName: 'Learner',
          lastName: 'One',
          avatar: null,
        },
      };
    });
    prisma.conversation.update.mockResolvedValueOnce({ id: 'conversation-1' });

    try {
      const response = await request(app)
        .post('/api/v1/messages/conversations/conversation-1')
        .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
        .field('content', 'Here is the worksheet')
        .attach('attachment', Buffer.from('example worksheet'), {
          filename: 'algebra-worksheet.pdf',
          contentType: 'application/pdf',
        });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(
        expect.objectContaining({
          content: 'Here is the worksheet',
          attachmentName: 'algebra-worksheet.pdf',
          attachmentType: 'application/pdf',
          attachmentSize: 17,
          attachmentUrl: expect.stringMatching(/^\/api\/v1\/messages\/attachments\//),
        })
      );
      expect(response.body.data.attachmentStorageKey).toBeUndefined();
    } finally {
      if (storedAttachmentKey) {
        await fs
          .unlink(path.resolve('uploads/chat-attachments', storedAttachmentKey))
          .catch(() => {});
      }
    }
  });

  test('allows only conversation participants to download an attachment', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.message.findUnique.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      attachmentName: 'private-notes.txt',
      attachmentStorageKey: 'private-notes.txt',
    });
    prisma.conversationParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await request(app)
      .get('/api/v1/messages/attachments/message-1')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Attachment not found');
  });

  test('downloads an attachment for a conversation participant', async () => {
    const storageKey = `message-test-${Date.now()}.txt`;
    const attachmentDirectory = path.resolve('uploads/chat-attachments');
    await fs.mkdir(attachmentDirectory, { recursive: true });
    await fs.writeFile(path.join(attachmentDirectory, storageKey), 'Private lesson notes');

    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.message.findUnique.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      attachmentName: 'lesson-notes.txt',
      attachmentStorageKey: storageKey,
    });
    prisma.conversationParticipant.findUnique.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      userId: learnerUser.id,
    });

    try {
      const response = await request(app)
        .get('/api/v1/messages/attachments/message-1')
        .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toContain('lesson-notes.txt');
      expect(response.text).toBe('Private lesson notes');
    } finally {
      await fs.unlink(path.join(attachmentDirectory, storageKey)).catch(() => {});
    }
  });

  test('does not send messages to a closed support conversation', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.conversationParticipant.findUnique.mockResolvedValueOnce({
      conversationId: 'support-conversation-1',
      userId: learnerUser.id,
      conversation: {
        status: 'CLOSED',
      },
    });

    const response = await request(app)
      .post('/api/v1/messages/conversations/support-conversation-1')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send({ content: 'Can I add one more thing?' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('This conversation is closed and read-only');
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  test('allows a support participant to close the conversation', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.conversationParticipant.findUnique.mockResolvedValueOnce({
      conversationId: 'support-conversation-1',
      userId: learnerUser.id,
      conversation: {
        id: 'support-conversation-1',
        type: 'SUPPORT',
        status: 'OPEN',
      },
    });
    prisma.conversation.update.mockResolvedValueOnce({
      id: 'support-conversation-1',
      type: 'SUPPORT',
      status: 'CLOSED',
      closedById: learnerUser.id,
      closedAt: new Date('2026-07-01T09:00:00.000Z'),
      participants: [],
      messages: [],
    });

    const response = await request(app)
      .patch('/api/v1/messages/conversations/support-conversation-1/close')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('CLOSED');
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'support-conversation-1' },
        data: expect.objectContaining({
          status: 'CLOSED',
          closedById: learnerUser.id,
          closedAt: expect.any(Date),
        }),
      })
    );
    expect(ioMock.to).toHaveBeenCalledWith('conversation:support-conversation-1');
    expect(ioEmit).toHaveBeenCalledWith(
      'conversation_closed',
      expect.objectContaining({
        conversationId: 'support-conversation-1',
        status: 'CLOSED',
        closedById: learnerUser.id,
      })
    );
  });

  test('returns unread message count for the authenticated user', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.message.count.mockResolvedValueOnce(3);

    const response = await request(app)
      .get('/api/v1/messages/unread-count')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { count: 3 },
    });
  });

  test('returns paginated notifications for the authenticated user', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.notification.findMany.mockResolvedValueOnce([
      {
        id: 'notification-1',
        userId: learnerUser.id,
        type: 'message',
        title: 'New message',
        message: 'You have a new message',
        read: false,
        timestamp: new Date('2026-04-23T09:00:00.000Z'),
        link: '/messages',
      },
    ]);
    prisma.notification.count.mockResolvedValueOnce(1);

    const response = await request(app)
      .get('/api/v1/notifications?status=unread&page=1&limit=10')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.notifications).toHaveLength(1);
    expect(response.body.data.pagination.total).toBe(1);
  });

  test('marks selected notifications as read', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(learnerUser);
    prisma.notification.updateMany.mockResolvedValueOnce({ count: 2 });

    const response = await request(app)
      .put('/api/v1/notifications/read?ids=n1,n2')
      .set('Authorization', `Bearer ${createAccessToken(learnerUser)}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      message: 'Notifications marked as read',
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['n1', 'n2'] },
        userId: learnerUser.id,
      },
      data: {
        read: true,
      },
    });
  });
});
