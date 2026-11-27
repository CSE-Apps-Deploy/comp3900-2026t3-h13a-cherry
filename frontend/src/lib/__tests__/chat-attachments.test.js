import { describe, expect, test } from 'vitest';
import {
  MAX_CHAT_ATTACHMENT_SIZE,
  formatAttachmentSize,
  validateChatAttachment,
} from '../chat-attachments';

const file = (name, size) => ({ name, size });

describe('chat attachment helpers', () => {
  test('accepts supported files up to 5 MB', () => {
    expect(validateChatAttachment(file('worksheet.pdf', MAX_CHAT_ATTACHMENT_SIZE))).toBe('');
    expect(validateChatAttachment(file('diagram.PNG', 1024))).toBe('');
    expect(validateChatAttachment(file('notes.docx', 2048))).toBe('');
  });

  test('rejects unsupported and oversized files', () => {
    expect(validateChatAttachment(file('archive.zip', 1024))).not.toBe('');
    expect(
      validateChatAttachment(file('large.pdf', MAX_CHAT_ATTACHMENT_SIZE + 1))
    ).not.toBe('');
  });

  test('formats attachment sizes for display', () => {
    expect(formatAttachmentSize(500)).toBe('500 B');
    expect(formatAttachmentSize(1500)).toBe('2 KB');
    expect(formatAttachmentSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});
