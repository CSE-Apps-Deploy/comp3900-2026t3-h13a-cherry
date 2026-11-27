const { prisma } = require('../config/database');

async function notify(receiverId, type, title, message, link, database = prisma) {
  await database.notification.create({
    data: {
      userId: receiverId,
      type,
      title,
      message,
      read: false,
      timestamp: new Date(),
      link,
    },
  });
}

async function notifyOrRefresh(receiverId, type, title, message, link, database = prisma) {
  const existingNotification = await database.notification.findFirst({
    where: {
      userId: receiverId,
      type,
      title,
      link,
    },
    orderBy: {
      timestamp: 'desc',
    },
  });

  if (existingNotification) {
    await database.notification.update({
      where: {
        id: existingNotification.id,
      },
      data: {
        message,
        read: false,
        timestamp: new Date(),
      },
    });
    return;
  }

  await notify(receiverId, type, title, message, link, database);
}

async function notifyAdmin(type, title, message, link) {
  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SYSTEM_ADMIN'] } },
  });

  const notifications = admins.map((admin) => ({
    userId: admin.id,
    type,
    title,
    message,
    read: false,
    timestamp: new Date(),
    link,
  }));

  if (!notifications.length) return;

  await prisma.notification.createMany({
    data: notifications,
  });
}

module.exports = {
  notify,
  notifyOrRefresh,
  notifyAdmin,
};
