'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import {
  ArrowDownTrayIcon,
  ChatBubbleLeftRightIcon,
  DocumentIcon,
  LifebuoyIcon,
  PaperClipIcon,
  PaperAirplaneIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { messageApi } from '../../../lib/api-entry';
import { getAvatarUrl } from '../../../lib/avatar';
import {
  CHAT_ATTACHMENT_ACCEPT,
  formatAttachmentSize,
  saveAttachmentBlob,
  validateChatAttachment,
} from '../../../lib/chat-attachments';
import { getSupportChatBadge } from '../../../lib/support-chat-badges';
import { getUserTimezone } from '../../../lib/formatters';
import { useAuthStore, useMessageStore } from '../../../lib/store';
import BackButton from '../../../components/BackButton';

let socket = null;

const IS_MOCK_CHAT = process.env.NEXT_PUBLIC_STAGE4_API_MODE === 'mock';

const formatTime = (value, timeZone) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
};

const getSocketUrl = () => {
  if (typeof window === 'undefined') return '';
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
  if (!apiUrl || apiUrl.startsWith('/')) return window.location.origin;

  try {
    return new URL(apiUrl).origin;
  } catch {
    return window.location.origin;
  }
};

export default function MessagesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { user, accessToken } = useAuthStore();
  const timeZone = getUserTimezone(user);
  const incrementUnread = useMessageStore((state) => state.incrementUnread);
  const setUnreadCount = useMessageStore((state) => state.setUnreadCount);
  const [selectedConversationId, setSelectedConversationId] = useState(
    searchParams.get('conversationId') || ''
  );
  const [messageInput, setMessageInput] = useState('');
  const [selectedAttachment, setSelectedAttachment] = useState(null);
  const [attachmentError, setAttachmentError] = useState('');
  const [downloadingMessageId, setDownloadingMessageId] = useState('');
  const [partnerTyping, setPartnerTyping] = useState(false);
  const requestedUserId = searchParams.get('userId') || '';
  const supportRequested = searchParams.get('support') === '1';
  const returnTo = searchParams.get('returnTo') || '';
  const messagesEndRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const canUseSupportChat = user?.role === 'LEARNER' || user?.role === 'TUTOR';

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['conversations', user?.id],
    queryFn: () => messageApi.getConversations(),
    enabled: !!user?.id,
  });

  const {
    data: messagesData,
    isLoading: messagesLoading,
    isError: messagesError,
    error: messagesQueryError,
  } = useQuery({
    queryKey: ['messages', selectedConversationId],
    queryFn: () => messageApi.getMessages(selectedConversationId),
    enabled: !!selectedConversationId,
  });

  const conversations =
    data?.data?.data?.conversations || data?.data?.data || [];
  const messages = messagesData?.data?.data?.messages || [];
  const selectedConversation = conversations.find(
    (conversation) => conversation.id === selectedConversationId
  );
  const selectedPartner = selectedConversation?.participants?.find(
    (item) => item.userId !== user?.id
  )?.user;
  const selectedIsSupport = selectedConversation?.type === 'SUPPORT';
  const selectedIsClosed = selectedConversation?.status === 'CLOSED';
  const showConversationList = !selectedConversationId;
  const showReturnButton = Boolean(user?.id && returnTo);

  const buildMessagesHref = (conversationId) => {
    const params = new URLSearchParams();

    if (conversationId) {
      params.set('conversationId', conversationId);
    }
    if (returnTo) {
      params.set('returnTo', returnTo);
    }

    const query = params.toString();
    return query ? `/messages?${query}` : '/messages';
  };

  const openSupportMutation = useMutation({
    mutationFn: () => messageApi.openSupportConversation(),
    onSuccess: (res) => {
      const conversationId = res?.data?.data?.id || '';
      if (!conversationId) return;
      setSelectedConversationId(conversationId);
      router.replace(buildMessagesHref(conversationId));
      queryClient.invalidateQueries({ queryKey: ['conversations', user?.id] });
    },
  });

  useEffect(() => {
    const nextId = searchParams.get('conversationId') || '';
    setSelectedConversationId(nextId);
  }, [searchParams]);

  useEffect(() => {
    if (!requestedUserId || !user?.id || selectedConversationId) return;

    let cancelled = false;

    messageApi
      .createConversation(requestedUserId)
      .then((res) => {
        if (cancelled) return;
        const conversationId = res?.data?.data?.id || '';
        if (!conversationId) return;
        setSelectedConversationId(conversationId);
        router.replace(buildMessagesHref(conversationId));
        queryClient.invalidateQueries({ queryKey: ['conversations', user?.id] });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [queryClient, requestedUserId, returnTo, router, selectedConversationId, user?.id]);

  useEffect(() => {
    if (!supportRequested || !user?.id || selectedConversationId || !canUseSupportChat) return;
    if (openSupportMutation.isPending) return;

    openSupportMutation.mutate();
  }, [canUseSupportChat, openSupportMutation, selectedConversationId, supportRequested, user?.id]);

  useEffect(() => {
    let cancelled = false;

    const syncUnread = async () => {
      if (!user?.id) return;
      try {
        const res = await messageApi.getUnreadCount();
        if (!cancelled) {
          setUnreadCount(res?.data?.data?.count || 0);
        }
      } catch {}
    };

    syncUnread();

    return () => {
      cancelled = true;
    };
  }, [setUnreadCount, user?.id]);

  useEffect(() => {
    if (!selectedConversationId) return;

    let cancelled = false;

    const markRead = async () => {
      try {
        await messageApi.markAsRead(selectedConversationId);
        const res = await messageApi.getUnreadCount();
        if (!cancelled) {
          setUnreadCount(res?.data?.data?.count || 0);
        }
        queryClient.invalidateQueries({ queryKey: ['conversations', user?.id] });
      } catch {}
    };

    markRead();

    return () => {
      cancelled = true;
    };
  }, [queryClient, selectedConversationId, setUnreadCount, user?.id]);

  useEffect(() => {
    if (!accessToken || IS_MOCK_CHAT) return;

    socket = io(getSocketUrl(), {
      auth: { token: accessToken },
    });

    socket.on('new_message', (message) => {
      queryClient.invalidateQueries({ queryKey: ['messages', message.conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations', user?.id] });

      if (message.conversationId !== selectedConversationId) {
        incrementUnread();
        return;
      }

      messageApi
        .markAsRead(message.conversationId)
        .then(() => messageApi.getUnreadCount())
        .then((res) => setUnreadCount(res?.data?.data?.count || 0))
        .catch(() => {});
    });

    socket.on('user_typing', ({ conversationId, userId, isTyping }) => {
      if (conversationId === selectedConversationId && userId !== user?.id) {
        setPartnerTyping(Boolean(isTyping));
      }
    });

    socket.on('conversation_closed', ({ conversationId }) => {
      queryClient.invalidateQueries({ queryKey: ['conversations', user?.id] });
      if (conversationId === selectedConversationId) {
        setPartnerTyping(false);
      }
    });

    return () => {
      socket?.disconnect();
      socket = null;
    };
  }, [accessToken, incrementUnread, queryClient, selectedConversationId, setUnreadCount, user?.id]);

  useEffect(() => {
    if (!socket || !selectedConversationId) return;

    socket.emit('join_conversation', selectedConversationId);

    return () => {
      socket?.emit('leave_conversation', selectedConversationId);
    };
  }, [selectedConversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, partnerTyping]);

  useEffect(() => {
    return () => {
      clearTimeout(typingTimeoutRef.current);
    };
  }, []);

  const sendMutation = useMutation({
    mutationFn: ({ conversationId, content, attachment }) => {
      const formData = new FormData();
      formData.append('content', content);
      if (attachment) formData.append('attachment', attachment);
      return messageApi.sendMessage(conversationId, formData);
    },
    onSuccess: () => {
      setMessageInput('');
      setSelectedAttachment(null);
      setAttachmentError('');
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
      queryClient.invalidateQueries({ queryKey: ['messages', selectedConversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations', user?.id] });
    },
  });

  const closeMutation = useMutation({
    mutationFn: (conversationId) => messageApi.closeConversation(conversationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', selectedConversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations', user?.id] });
    },
  });

  const handleSend = () => {
    const content = messageInput.trim();
    if ((!content && !selectedAttachment) || !selectedConversationId || selectedIsClosed) return;
    sendMutation.mutate({
      conversationId: selectedConversationId,
      content,
      attachment: selectedAttachment,
    });
  };

  const handleAttachmentChange = (event) => {
    const file = event.target.files?.[0] || null;
    const validationError = validateChatAttachment(file);
    setAttachmentError(validationError);
    setSelectedAttachment(validationError ? null : file);
    if (validationError) event.target.value = '';
  };

  const clearAttachment = () => {
    setSelectedAttachment(null);
    setAttachmentError('');
    if (attachmentInputRef.current) attachmentInputRef.current.value = '';
  };

  const handleDownloadAttachment = async (message) => {
    if (!message?.id || downloadingMessageId) return;
    setDownloadingMessageId(message.id);
    setAttachmentError('');

    try {
      const response = await messageApi.downloadAttachment(message.id);
      saveAttachmentBlob(response.data, message.attachmentName);
    } catch (error) {
      setAttachmentError(error?.response?.data?.message || 'Attachment download failed');
    } finally {
      setDownloadingMessageId('');
    }
  };

  const handleTyping = () => {
    if (!socket || !selectedConversationId || selectedIsClosed) return;
    socket.emit('typing', { conversationId: selectedConversationId, isTyping: true });
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket?.emit('typing', { conversationId: selectedConversationId, isTyping: false });
    }, 1200);
  };

  const handleSelectConversation = (conversationId) => {
    setSelectedConversationId(conversationId);
    router.replace(buildMessagesHref(conversationId));
  };

  const handleBackToList = () => {
    if (showReturnButton) {
      router.push(returnTo);
      return;
    }
    setSelectedConversationId('');
    setPartnerTyping(false);
    router.replace('/messages');
  };

  const handleOpenSupport = () => {
    if (!canUseSupportChat || openSupportMutation.isPending) return;
    openSupportMutation.mutate();
  };

  const handleCloseSupport = () => {
    if (!selectedConversationId || !selectedIsSupport || selectedIsClosed) return;
    closeMutation.mutate(selectedConversationId);
  };

  return (
    <div className="w-full">
      <div className="mb-4 flex flex-wrap items-start gap-3 md:mb-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-gray-900 md:text-2xl">Messages</h1>
          <p className="mt-1 text-sm text-gray-500">Chat with tutors and learners here.</p>
        </div>
        {showReturnButton && (
          <BackButton
            onClick={() => router.push(returnTo)}
            className="hidden md:inline-flex"
          />
        )}
        {canUseSupportChat && (
          <button
            type="button"
            onClick={handleOpenSupport}
            disabled={openSupportMutation.isPending}
            className="btn-secondary inline-flex items-center gap-2 disabled:opacity-50"
          >
            <LifebuoyIcon className="h-4 w-4" />
            {openSupportMutation.isPending ? 'Opening support' : 'Support Chat'}
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm md:grid md:grid-cols-[320px_1fr]">
        <div
          className={`md:block ${showConversationList ? 'block' : 'hidden'} border-b border-gray-200 md:border-b-0 md:border-r`}
        >
          <div className="border-b border-gray-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-gray-900">All chats</h2>
          </div>

          {isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3 animate-pulse">
                  <div className="h-10 w-10 rounded-full bg-gray-200" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/2 rounded bg-gray-200" />
                    <div className="h-3 w-2/3 rounded bg-gray-200" />
                  </div>
                </div>
              ))}
            </div>
          ) : isError ? (
            <div className="p-4 text-sm text-red-600">
              {error?.response?.data?.message || 'Failed to load chats.'}
            </div>
          ) : conversations.length === 0 ? (
            <div className="p-8 text-center">
              <ChatBubbleLeftRightIcon className="mx-auto h-10 w-10 text-gray-300" />
              <p className="mt-3 text-sm font-medium text-gray-900">No chats yet</p>
              <p className="mt-1 text-sm text-gray-500">Your conversations will show up here.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {conversations.map((conversation) => {
                const partner = conversation.participants?.find(
                  (item) => item.userId !== user?.id
                )?.user;
                const lastMessage = conversation.lastMessage || conversation.messages?.[0];
                const isSelected = selectedConversationId === conversation.id;
                const unread = conversation.unreadCount || 0;
                const supportRequester = conversation.participants?.find(
                  (item) => item.userId === conversation.supportRequesterId
                )?.user;
                const supportBadge = getSupportChatBadge({
                  viewerRole: user?.role,
                  requesterRole: supportRequester?.role || partner?.role,
                });

                return (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => handleSelectConversation(conversation.id)}
                    className={`flex w-full items-start gap-3 px-4 py-4 text-left transition ${
                      isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                    >
                    <div className="relative">
                      <img
                        src={getAvatarUrl(
                          partner?.avatar,
                          partner?.firstName,
                          partner?.lastName,
                          { fallbackName: 'User' }
                        )}
                        alt={partner?.firstName || 'User'}
                        className="h-10 w-10 rounded-full object-cover"
                      />
                      {unread > 0 && (
                        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                          {unread > 9 ? '9+' : unread}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className={`truncate text-sm ${unread > 0 ? 'font-bold text-gray-900' : 'font-semibold text-gray-900'}`}>
                          {partner?.firstName || 'User'} {partner?.lastName || ''}
                        </p>
                        <span className="shrink-0 text-xs text-gray-400">
                          {formatTime(lastMessage?.createdAt, timeZone)}
                        </span>
                      </div>
                      <p className={`mt-1 truncate text-sm ${unread > 0 ? 'font-medium text-gray-700' : 'text-gray-500'}`}>
                        {lastMessage?.content ||
                          (lastMessage?.attachmentName
                            ? `Attachment: ${lastMessage.attachmentName}`
                            : 'No messages yet')}
                      </p>
                      {conversation.type === 'SUPPORT' && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${supportBadge.className}`}
                          >
                            {supportBadge.label}
                          </span>
                          {conversation.status === 'CLOSED' && (
                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                              Closed
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {!selectedConversationId ? (
          <div className="hidden min-h-[320px] items-center justify-center p-10 text-center md:flex">
            <div>
              <ChatBubbleLeftRightIcon className="mx-auto h-12 w-12 text-gray-300" />
              <h2 className="mt-4 text-lg font-semibold text-gray-900">Pick a chat</h2>
              <p className="mt-2 text-sm text-gray-500">
                Choose a conversation from the list.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex h-[calc(100dvh-11.5rem)] min-h-[32rem] flex-col md:h-[calc(100dvh-10rem)] md:min-h-[520px]">
            <div className="border-b border-gray-100 px-4 py-3 md:px-5 md:py-4">
              <div className="flex items-center gap-3">
                <BackButton
                  onClick={handleBackToList}
                  className="md:hidden"
                  label="Back to chats"
                  variant="icon"
                  iconOnly
                />
                <img
                  src={getAvatarUrl(
                    selectedPartner?.avatar,
                    selectedPartner?.firstName,
                    selectedPartner?.lastName,
                    { fallbackName: 'User' }
                  )}
                  alt={selectedPartner?.firstName || 'User'}
                  className="h-10 w-10 rounded-full object-cover"
                />
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {selectedPartner?.firstName || 'User'} {selectedPartner?.lastName || ''}
                  </p>
                  <p className="text-xs text-gray-500">
                    {selectedIsSupport
                      ? selectedIsClosed
                        ? 'Closed admin support chat'
                        : 'Admin support chat'
                      : 'Conversation'}
                  </p>
                </div>
                {selectedIsSupport && !selectedIsClosed && (
                  <button
                    type="button"
                    onClick={handleCloseSupport}
                    disabled={closeMutation.isPending}
                    className="btn-secondary ml-auto text-xs disabled:opacity-50"
                  >
                    {closeMutation.isPending
                      ? 'Closing'
                      : user?.role === 'ADMIN' || user?.role === 'SYSTEM_ADMIN'
                        ? 'Close conversation'
                        : 'Mark as resolved'}
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto bg-gray-50 p-3 md:p-4">
              {messagesLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div
                      key={index}
                      className={`flex ${index % 2 === 0 ? 'justify-start' : 'justify-end'}`}
                    >
                      <div className="h-14 w-44 rounded-2xl bg-gray-200 animate-pulse" />
                    </div>
                  ))}
                </div>
              ) : messagesError ? (
                <div className="text-sm text-red-600">
                  {messagesQueryError?.response?.data?.message || 'Failed to load messages.'}
                </div>
              ) : messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div>
                    <ChatBubbleLeftRightIcon className="mx-auto h-10 w-10 text-gray-300" />
                    <p className="mt-3 text-sm font-medium text-gray-900">No messages yet</p>
                    <p className="mt-1 text-sm text-gray-500">Say hi to start the chat.</p>
                  </div>
                </div>
              ) : (
                messages.map((message) => {
                  const isMine = message.senderId === user?.id;

                  return (
                    <div
                      key={message.id}
                      className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-2xl px-3 py-2.5 text-sm md:max-w-[75%] md:px-4 md:py-3 ${
                          isMine
                            ? 'rounded-br-sm bg-blue-600 text-white'
                            : 'rounded-bl-sm bg-white text-gray-900 border border-gray-200'
                        }`}
                      >
                        {message.content && <p className="whitespace-pre-wrap">{message.content}</p>}
                        {message.attachmentName && (
                          <button
                            type="button"
                            onClick={() => handleDownloadAttachment(message)}
                            disabled={downloadingMessageId === message.id}
                            className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition disabled:opacity-60 ${
                              message.content ? 'mt-2' : ''
                            } ${
                              isMine
                                ? 'border-blue-400 bg-blue-500 hover:bg-blue-400'
                                : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                            }`}
                          >
                            <DocumentIcon className="h-5 w-5 shrink-0" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">
                                {message.attachmentName}
                              </span>
                              <span
                                className={`block text-xs ${
                                  isMine ? 'text-blue-100' : 'text-gray-500'
                                }`}
                              >
                                {formatAttachmentSize(message.attachmentSize)}
                              </span>
                            </span>
                            <ArrowDownTrayIcon className="h-4 w-4 shrink-0" />
                          </button>
                        )}
                        <p
                          className={`mt-1 text-xs ${
                            isMine ? 'text-blue-100' : 'text-gray-400'
                          }`}
                        >
                          {formatTime(message.createdAt, timeZone)}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
              {partnerTyping && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-sm border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500">
                    typing...
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="border-t border-gray-100 bg-white p-3 md:p-4">
              {selectedIsClosed && (
                <div className="mb-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                  This support conversation is closed and is now read-only.
                </div>
              )}
              {selectedAttachment && (
                <div className="mb-2 flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                  <DocumentIcon className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{selectedAttachment.name}</span>
                  <span className="shrink-0 text-xs text-blue-700">
                    {formatAttachmentSize(selectedAttachment.size)}
                  </span>
                  <button
                    type="button"
                    onClick={clearAttachment}
                    className="rounded p-1 hover:bg-blue-100"
                    aria-label="Remove attachment"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>
              )}
              {(attachmentError || sendMutation.isError) && (
                <p className="mb-2 text-sm text-red-600">
                  {attachmentError ||
                    sendMutation.error?.response?.data?.message ||
                    'Message could not be sent'}
                </p>
              )}
              <div className="flex items-end gap-2">
                <input
                  ref={attachmentInputRef}
                  type="file"
                  accept={CHAT_ATTACHMENT_ACCEPT}
                  onChange={handleAttachmentChange}
                  disabled={selectedIsClosed || sendMutation.isPending}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={selectedIsClosed || sendMutation.isPending}
                  className="btn-secondary inline-flex h-12 shrink-0 items-center justify-center px-3 disabled:opacity-50"
                  aria-label="Add attachment"
                  title="Add attachment"
                >
                  <PaperClipIcon className="h-5 w-5" />
                </button>
                <textarea
                  value={messageInput}
                  onChange={(event) => {
                    setMessageInput(event.target.value);
                    handleTyping();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      handleSend();
                    } else {
                      handleTyping();
                    }
                  }}
                  disabled={selectedIsClosed}
                  placeholder={selectedIsClosed ? 'This conversation is read-only.' : 'Type a message...'}
                  rows={2}
                  className="input min-h-[48px] flex-1 resize-none px-3 py-2.5 md:px-4 md:py-3"
                />
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={
                    (!messageInput.trim() && !selectedAttachment) ||
                    sendMutation.isPending ||
                    selectedIsClosed
                  }
                  className="btn-primary inline-flex h-12 shrink-0 items-center gap-2 px-3 md:px-4 disabled:opacity-50"
                >
                  <PaperAirplaneIcon className="h-4 w-4" />
                  <span className="hidden sm:inline">
                    {sendMutation.isPending ? 'Sending' : 'Send'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
