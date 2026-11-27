export const MAX_CHAT_ATTACHMENT_SIZE = 5 * 1024 * 1024;
export const CHAT_ATTACHMENT_ACCEPT = '.jpg,.jpeg,.png,.gif,.webp,.pdf,.doc,.docx,.txt';

const ALLOWED_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'pdf',
  'doc',
  'docx',
  'txt',
]);

export function validateChatAttachment(file) {
  if (!file) return '';

  const extension = String(file.name || '').split('.').pop()?.toLowerCase();
  if (!extension || !ALLOWED_EXTENSIONS.has(extension)) {
    return 'Choose an image, PDF, Word document, or text file';
  }
  if (Number(file.size || 0) > MAX_CHAT_ATTACHMENT_SIZE) {
    return 'Attachment must be 5 MB or smaller';
  }

  return '';
}

export function formatAttachmentSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function saveAttachmentBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'attachment';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
