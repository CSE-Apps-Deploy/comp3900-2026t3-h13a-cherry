// server.js - Entry Point
require('dotenv').config();
require('express-async-errors');

const http = require('http');

const app = require('./src/app');
const { initSocket } = require('./src/services/socketService');
const {
  repairLegacyCompletionReviews,
  startCompletionReviewWorker,
} = require('./src/services/completionReviewService');
const { prisma } = require('./src/config/database');
const logger = require('./src/config/logger');

const PORT = process.env.PORT || 5050;
const server = http.createServer(app);
let stopCompletionReviewWorker = null;

initSocket(server);

// Start server
const start = async () => {
  try {
    await prisma.$connect();
    logger.info('Database connected successfully');
    const legacyRepair = await repairLegacyCompletionReviews();
    if (Object.values(legacyRepair).some(Boolean)) {
      logger.info('Normalised legacy completion reviews', legacyRepair);
    }
    stopCompletionReviewWorker = startCompletionReviewWorker();

    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
      logger.info(`API Docs: http://localhost:${PORT}/api/v1/health`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  stopCompletionReviewWorker?.();
  await prisma.$disconnect();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

start();
