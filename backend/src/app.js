const { UPLOAD_DIR } = require('./middleware/upload');
const express = require('express');
require('express-async-errors');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const { notFound, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const tutorRoutes = require('./routes/tutors');
const subjectRoutes = require('./routes/subjects');
const bookingRoutes = require('./routes/bookings');
const paymentRoutes = require('./routes/payments');
const messageRoutes = require('./routes/messages');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');
const reviewRoutes = require('./routes/reviews');
const subjectRequestRoutes = require('./routes/subjectRequests');
const paymentController = require('./controllers/paymentController');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.set('trust proxy', 1);
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin.trim().replace(/\/+$/, ''))) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked: ${origin}`));
    },
  })
);
app.post(
  '/api/v1/payments/stripe/webhook',
  express.raw({ type: 'application/json' }),
  paymentController.handleStripeWebhook
);
app.use(express.json());
app.use(morgan('dev'));
app.use('/uploads/chat-attachments', (_req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});
app.use('/uploads/documents', (_req, res) => res.status(404).json({ success: false, message: 'Not found' }));
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader('Content-Disposition', 'inline');
  },
}));

app.get('/health', (_req, res) => {
  res.json({ success: true, name: 'TutorConnect API', timestamp: new Date().toISOString() });
});

app.get('/api/v1/health', (_req, res) => {
  res.json({ success: true, name: 'TutorConnect API', timestamp: new Date().toISOString() });
});

// Sprint 1: additional auth and booking endpoints.
const passwordResetRoutes = require('./routes/passwordReset');
const meetingLinkRoutes = require('./routes/meetingLinks');
app.use('/api/v1/auth', passwordResetRoutes);
app.use('/api/v1/bookings', meetingLinkRoutes);

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/tutors', tutorRoutes);
app.use('/api/v1/subjects', subjectRoutes);
app.use('/api/v1/bookings', bookingRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/messages', messageRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/reviews', reviewRoutes);
app.use('/api/v1/subject-requests', subjectRequestRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
