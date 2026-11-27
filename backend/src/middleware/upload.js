const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { AppError } = require('./errorHandler');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads'));
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const CHAT_ATTACHMENT_DIR = path.join(UPLOAD_DIR, 'chat-attachments');
const ALLOWED_EXTENSIONS = new Set([
  'jpeg',
  'jpg',
  'png',
  'gif',
  'webp',
  'pdf',
  'doc',
  'docx',
  'txt',
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder =
      file.fieldname === 'avatar'
        ? 'avatars'
        : file.fieldname === 'attachment'
          ? 'chat-attachments'
          : 'documents';
    const targetDir = path.join(UPLOAD_DIR, folder);
    fs.mkdirSync(targetDir, { recursive: true });
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  if (file.fieldname === 'avatar' && !['jpeg', 'jpg', 'png', 'gif', 'webp'].includes(ext)) {
    return cb(new AppError('Avatar must be an image file.', 400));
  }
  if (ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
  cb(new AppError('Invalid file type', 400));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

const uploadChatAttachment = (req, res, next) => {
  upload.single('attachment')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError('Attachment must be 5 MB or smaller', 400));
    }
    if (error instanceof multer.MulterError) {
      return next(new AppError(error.message, 400));
    }
    return next(error);
  });
};

module.exports = {
  UPLOAD_DIR,
  CHAT_ATTACHMENT_DIR,
  MAX_FILE_SIZE,
  upload,
  uploadChatAttachment,
};
