const fs = require('fs/promises');

const prisma = {
  user: { findMany: vi.fn(), findUnique: vi.fn() },
  conversation: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  conversationParticipant: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  message: { count: vi.fn(), findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
};
let socketIO = null;

const databasePath = require.resolve('../../src/config/database');
const socketPath = require.resolve('../../src/services/socketService');
const controllerPath = require.resolve('../../src/controllers/messageController');
for (const modulePath of [databasePath, socketPath, controllerPath]) delete require.cache[modulePath];
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { prisma },
};
require.cache[socketPath] = {
  id: socketPath,
  filename: socketPath,
  loaded: true,
  exports: { getSocketIO: () => socketIO },
};

const controller = require('../../src/controllers/messageController');

const makeResponse = () => {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.download = vi.fn(() => res);
  return res;
};
const req = (overrides = {}) => ({
  user: { id: 'user-1', role: 'LEARNER' },
  params: {},
  query: {},
  body: {},
  ...overrides,
});
const conversation = (overrides = {}) => ({
  id: 'conversation-1',
  status: 'OPEN',
  participants: [{ userId: 'user-1', lastReadAt: null }],
  messages: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  socketIO = null;
});

describe('message controller fallback branches', () => {
  test('lists conversations with and without unread cutoffs or last messages', async () => {
    prisma.conversation.findMany.mockResolvedValue([
      conversation(),
      conversation({
        id: 'conversation-2',
        participants: [{ userId: 'user-1', lastReadAt: new Date() }],
        messages: [{ id: 'message-1' }],
      }),
    ]);
    prisma.message.count.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const res = makeResponse();
    await controller.getConversations(req(), res);
    const results = res.json.mock.calls[0][0].data.conversations;
    expect(results[0].lastMessage).toBeNull();
    expect(results[1].lastMessage.id).toBe('message-1');
  });

  test.each([
    [{}, 400],
    [{ userId: 'user-1' }, 400],
  ])('rejects invalid direct conversation targets', async (body, statusCode) => {
    await expect(controller.createOrGetConversation(req({ body }), makeResponse())).rejects.toMatchObject({ statusCode });
  });

  test('rejects an unknown conversation target', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      controller.createOrGetConversation(req({ body: { participantId: 'missing' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('returns an existing direct conversation with no last message', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-2' });
    prisma.conversation.findFirst.mockResolvedValue(conversation());
    const res = makeResponse();
    await controller.createOrGetConversation(req({ body: { userId: 'user-2' } }), res);
    expect(res.json.mock.calls[0][0].data.lastMessage).toBeNull();
  });

  test('creates a new direct conversation', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-2' });
    prisma.conversation.findFirst.mockResolvedValue(null);
    prisma.conversation.create.mockResolvedValue(conversation());
    const res = makeResponse();
    await controller.createOrGetConversation(req({ body: { userId: 'user-2' } }), res);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('rejects support requests from admins and when no admin is available', async () => {
    await expect(
      controller.openSupportConversation(req({ user: { id: 'admin-1', role: 'ADMIN' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 403 });

    prisma.conversation.findFirst.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([]);
    await expect(controller.openSupportConversation(req(), makeResponse())).rejects.toMatchObject({ statusCode: 404 });
  });

  test('assigns support to the least busy admin', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);
    prisma.conversation.findMany.mockResolvedValue([
      { supportAssignedAdminId: null },
      { supportAssignedAdminId: 'admin-1' },
      { supportAssignedAdminId: 'admin-1' },
    ]);
    prisma.conversation.create.mockResolvedValue(conversation({ messages: [{ id: 'welcome' }] }));
    const res = makeResponse();
    await controller.openSupportConversation(req(), res);
    expect(prisma.conversation.create.mock.calls[0][0].data.supportAssignedAdminId).toBe('admin-2');
    expect(res.json.mock.calls[0][0].data.lastMessage.id).toBe('welcome');
  });

  test('returns an existing support conversation', async () => {
    prisma.conversation.findFirst.mockResolvedValue(conversation());
    const res = makeResponse();
    await controller.openSupportConversation(req(), res);
    expect(res.json.mock.calls[0][0].data.lastMessage).toBeNull();
  });

  test('validates participation and bounds message pagination', async () => {
    prisma.conversationParticipant.findUnique.mockResolvedValueOnce(null);
    await expect(
      controller.getConversationMessages(req({ params: { conversationId: 'missing' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });

    prisma.conversationParticipant.findUnique.mockResolvedValue({ userId: 'user-1' });
    prisma.message.findMany.mockResolvedValue([{ id: 'message-2' }, { id: 'message-1' }]);
    prisma.message.count.mockResolvedValue(2);
    const res = makeResponse();
    await controller.getConversationMessages(
      req({ params: { conversationId: 'conversation-1' }, query: { page: '-2', limit: '500' } }),
      res
    );
    expect(res.json.mock.calls[0][0].data.pagination).toEqual({ page: 1, limit: 100, total: 2 });
  });

  test('rejects empty, unknown, closed, and recipient-less message sends', async () => {
    await expect(
      controller.sendMessage(req({ params: { conversationId: 'conversation-1' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 400 });

    prisma.conversationParticipant.findUnique.mockResolvedValueOnce(null);
    await expect(
      controller.sendMessage(req({ params: { conversationId: 'conversation-1' }, body: { content: 'Hi' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });

    prisma.conversationParticipant.findUnique.mockResolvedValueOnce({ conversation: { status: 'CLOSED' } });
    await expect(
      controller.sendMessage(req({ params: { conversationId: 'conversation-1' }, body: { content: 'Hi' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 400 });

    prisma.conversationParticipant.findUnique.mockResolvedValueOnce({ conversation: { status: 'OPEN' } });
    prisma.conversationParticipant.findFirst.mockResolvedValueOnce(null);
    await expect(
      controller.sendMessage(req({ params: { conversationId: 'conversation-1' }, body: { content: 'Hi' } }), makeResponse())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('sends attachment metadata and emits to both socket rooms', async () => {
    prisma.conversationParticipant.findUnique.mockResolvedValue({ conversation: { status: 'OPEN' } });
    prisma.conversationParticipant.findFirst.mockResolvedValue({ userId: 'user-2' });
    prisma.message.create.mockResolvedValue({ id: 'message-1' });
    prisma.conversation.update.mockResolvedValue({});
    const emit = vi.fn();
    socketIO = { to: vi.fn(() => ({ emit })) };
    const res = makeResponse();
    await controller.sendMessage(
      req({
        params: { conversationId: 'conversation-1' },
        file: { mimetype: 'image/png', originalname: 'a.png', size: 2, filename: 'stored.png' },
      }),
      res
    );
    expect(prisma.message.create.mock.calls[0][0].data.attachmentStorageKey).toBe('stored.png');
    expect(socketIO.to).toHaveBeenCalledTimes(2);
  });

  test('validates attachment records, ownership, and storage keys', async () => {
    prisma.message.findUnique.mockResolvedValueOnce(null);
    await expect(controller.downloadAttachment(req(), makeResponse())).rejects.toMatchObject({ statusCode: 404 });

    prisma.message.findUnique.mockResolvedValue({ conversationId: 'c', attachmentStorageKey: 'file.txt' });
    prisma.conversationParticipant.findUnique.mockResolvedValueOnce(null);
    await expect(controller.downloadAttachment(req(), makeResponse())).rejects.toMatchObject({ statusCode: 404 });

    prisma.conversationParticipant.findUnique.mockResolvedValue({ userId: 'user-1' });
    prisma.message.findUnique.mockResolvedValue({ conversationId: 'c', attachmentStorageKey: '../file.txt' });
    await expect(controller.downloadAttachment(req(), makeResponse())).rejects.toMatchObject({ statusCode: 404 });
  });

  test('downloads an accessible attachment with a fallback name', async () => {
    prisma.message.findUnique.mockResolvedValue({ conversationId: 'c', attachmentStorageKey: 'file.txt', attachmentName: '' });
    prisma.conversationParticipant.findUnique.mockResolvedValue({ userId: 'user-1' });
    vi.spyOn(fs, 'access').mockResolvedValueOnce();
    const res = makeResponse();
    await controller.downloadAttachment(req(), res);
    expect(res.download.mock.calls[0][1]).toBe('attachment');
  });

  test('closes open support chats and leaves closed chats unchanged', async () => {
    const emit = vi.fn();
    socketIO = { to: vi.fn(() => ({ emit })) };
    for (const status of ['OPEN', 'CLOSED']) {
      prisma.conversationParticipant.findUnique.mockResolvedValue({
        conversation: { id: 'conversation-1', type: 'SUPPORT', status },
      });
      prisma.conversation.update.mockResolvedValue(conversation({ status: 'CLOSED' }));
      await controller.closeConversation(req({ params: { conversationId: 'conversation-1' } }), makeResponse());
    }
    expect(prisma.conversation.update.mock.calls[1][0].data).toEqual({});
    expect(emit).toHaveBeenCalled();
  });

  test('marks messages read with and without sockets', async () => {
    prisma.conversationParticipant.findUnique.mockResolvedValue({ userId: 'user-1' });
    prisma.conversationParticipant.update.mockResolvedValue({});
    prisma.message.updateMany.mockResolvedValue({ count: 1 });
    await controller.markAsRead(req({ params: { conversationId: 'c' } }), makeResponse());
    const emit = vi.fn();
    socketIO = { to: vi.fn(() => ({ emit })) };
    await controller.markAsRead(req({ params: { conversationId: 'c' } }), makeResponse());
    expect(emit).toHaveBeenCalled();
  });
});
