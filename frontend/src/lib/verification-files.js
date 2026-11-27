import api from './api-services/client';
import { saveAttachmentBlob } from './chat-attachments';

export async function downloadVerificationFile(file, tutorId) {
  const filename = (file.url || '').split('/').pop();
  const response = await api.get(`/tutors/${encodeURIComponent(tutorId)}/verification-files/${encodeURIComponent(filename)}`, {
    responseType: 'blob',
  });
  saveAttachmentBlob(response.data, file.originalName || file.fileName || filename);
}
