import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { MessageEnvelope } from '../crypto/envelope';
import { SuccessResponse } from '../models/api.model';
import {
    Chat,
    ChatParticipant,
    InviteLink,
    InviteLinkJoinResult,
    InviteLinkPreview,
    ParticipantReadState,
    ParticipantRole,
    UserSearchResult,
} from '../models/chat.model';
import { ChannelPostPayload, ForwardOrigin, MessageAttachment, MessageResponse } from '../models/crypto.model';
import { ConfigService } from './config.service';

@Injectable({ providedIn: 'root' })
export class ChatApiService {
    private readonly http = inject(HttpClient);
    private readonly configService = inject(ConfigService);

    private get chatsUrl(): string {
        return this.configService.apiUrl + 'chats/';
    }

    private get messagesUrl(): string {
        return this.configService.apiUrl + 'messages/';
    }

    /**
     * The token-scoped invite-link endpoints (`preview`/`join`/`revoke`) are not addressed by chat
     * id at all — see `invite_link_routes.py`'s `router`, kept deliberately separate from the
     * chat-scoped create/list pair.
     */
    private get inviteLinksUrl(): string {
        return this.configService.apiUrl + 'invite-links/';
    }

    getChats(): Observable<Chat[]> {
        return this.http.get<SuccessResponse<Chat[]>>(this.chatsUrl).pipe(map((r) => r.data));
    }

    getChat(chatId: string): Observable<Chat> {
        return this.http.get<SuccessResponse<Chat>>(`${this.chatsUrl}${chatId}`).pipe(map((r) => r.data));
    }

    /**
     * Every participant's own read high-water mark for this chat, in one payload.
     *
     * Refetched on `openChat` and on a `message_read` broadcast for the active chat, rather than
     * queried per message — the client already holds every rendered message's id, so it derives
     * read status (and a group's "read by N of M") locally by comparing ids.
     */
    getReadState(chatId: string): Observable<ParticipantReadState[]> {
        return this.http
            .get<SuccessResponse<ParticipantReadState[]>>(`${this.chatsUrl}${chatId}/read-state`)
            .pipe(map((r) => r.data));
    }

    createPrivateChat(targetUserId: string): Observable<Chat> {
        return this.http
            .post<SuccessResponse<Chat>>(`${this.chatsUrl}private`, { target_user_id: targetUserId })
            .pipe(map((r) => r.data));
    }

    createGroupChat(title: string, description: string, participantIds: string[]): Observable<Chat> {
        return this.http
            .post<SuccessResponse<Chat>>(`${this.chatsUrl}group`, {
                title,
                description,
                participant_ids: participantIds,
            })
            .pipe(map((r) => r.data));
    }

    createChannel(title: string, description: string, subscriberIds: string[]): Observable<Chat> {
        return this.http
            .post<SuccessResponse<Chat>>(`${this.chatsUrl}channel`, {
                title,
                description,
                subscriber_ids: subscriberIds,
            })
            .pipe(map((r) => r.data));
    }

    leaveChat(chatId: string): Observable<unknown> {
        return this.http.post<SuccessResponse<unknown>>(`${this.chatsUrl}${chatId}/leave`, {}).pipe(map((r) => r.data));
    }

    addParticipants(chatId: string, userIds: string[]): Observable<Chat> {
        return this.http
            .post<SuccessResponse<Chat>>(`${this.chatsUrl}${chatId}/add-participants`, { user_ids: userIds })
            .pipe(map((r) => r.data));
    }

    removeParticipants(chatId: string, userIds: string[]): Observable<Chat> {
        return this.http
            .post<SuccessResponse<Chat>>(`${this.chatsUrl}${chatId}/delete-participants`, { user_ids: userIds })
            .pipe(map((r) => r.data));
    }

    getMessages(chatId: string, limit = 50, beforeId?: string): Observable<MessageResponse[]> {
        let params = new HttpParams().set('limit', limit);
        if (beforeId) {
            params = params.set('before_id', beforeId);
        }

        return this.http
            .get<SuccessResponse<MessageResponse[]>>(`${this.chatsUrl}${chatId}/messages`, { params })
            .pipe(map((r) => r.data));
    }

    /** Send a sealed message into an encrypted chat. */
    sendEnvelope(
        chatId: string,
        envelope: MessageEnvelope,
        replyTo?: string,
        attachments?: MessageAttachment[],
        forwardedFrom?: ForwardOrigin
    ): Observable<MessageResponse> {
        return this.http
            .post<SuccessResponse<MessageResponse>>(this.messagesUrl, {
                chat_id: chatId,
                envelope,
                reply_to_message_id: replyTo ?? null,
                attachments: attachments?.length ? attachments : null,
                forwarded_from: forwardedFrom ?? null,
            })
            .pipe(map((r) => r.data));
    }

    /**
     * Where to fetch an attachment.
     *
     * Not the URL the upload returned: that points straight at MinIO, and the message bucket is
     * private with no anonymous read. The API has to authorise the fetch, so the object key is
     * re-addressed through it.
     */
    attachmentUrl(chatId: string, storedUrl: string): string {
        const objectKey = storedUrl.split('/').pop() ?? '';
        return `${this.configService.apiUrl}files/attachments/${chatId}/${objectKey}`;
    }

    /** Send a signed broadcast post. Channels are authenticated but not confidential. */
    sendChannelPost(chatId: string, post: ChannelPostPayload): Observable<MessageResponse> {
        return this.http
            .post<SuccessResponse<MessageResponse>>(this.messagesUrl, { chat_id: chatId, channel_post: post })
            .pipe(map((r) => r.data));
    }

    deleteMessage(messageId: string): Observable<unknown> {
        return this.http.delete<SuccessResponse<unknown>>(`${this.messagesUrl}${messageId}`).pipe(map((r) => r.data));
    }

    /** Resolve user ids to display names. The only endpoint keyed by id. */
    getUsersBatch(userIds: string[]): Observable<UserSearchResult[]> {
        return this.http
            .post<SuccessResponse<UserSearchResult[]>>(`${this.configService.apiUrl}users/batch`, {
                user_ids: userIds,
            })
            .pipe(map((r) => r.data));
    }

    changeRole(chatId: string, userId: string, role: ParticipantRole): Observable<ChatParticipant> {
        return this.http
            .post<SuccessResponse<ChatParticipant>>(`${this.chatsUrl}${chatId}/change-role`, {
                user_id: userId,
                role,
            })
            .pipe(map((r) => r.data));
    }

    /**
     * Hand ownership to another member; the caller is demoted to admin.
     *
     * Separate from `changeRole`, which refuses to grant OWNER — a chat must never be observable
     * with two owners or none, so the swap is one server-side transaction rather than two calls.
     */
    transferOwnership(chatId: string, userId: string): Observable<ChatParticipant> {
        return this.http
            .post<SuccessResponse<ChatParticipant>>(`${this.chatsUrl}${chatId}/transfer-ownership`, {
                user_id: userId,
            })
            .pipe(map((r) => r.data));
    }

    /** Delete a group or channel and every message in it. Owner only, and irreversible. */
    deleteChat(chatId: string): Observable<unknown> {
        return this.http.delete<SuccessResponse<unknown>>(`${this.chatsUrl}${chatId}`).pipe(map((r) => r.data));
    }

    /** Edit a message. The envelope must carry a FRESH chain index; reuse is rejected. */
    editMessage(messageId: string, envelope: MessageEnvelope): Observable<MessageResponse> {
        return this.http
            .put<SuccessResponse<MessageResponse>>(`${this.messagesUrl}${messageId}`, { envelope })
            .pipe(map((r) => r.data));
    }

    searchUsers(query: string, limit = 10): Observable<UserSearchResult[]> {
        return this.http
            .get<SuccessResponse<UserSearchResult[]>>(`${this.configService.apiUrl}users/search`, {
                params: new HttpParams().set('query', query).set('limit', limit),
            })
            .pipe(map((r) => r.data));
    }

    /**
     * Toggle the caller's reaction with this emoji: the same emoji from the same user removes it,
     * a different one adds an additional, independent reaction.
     */
    toggleReaction(messageId: string, emoji: string): Observable<MessageResponse> {
        return this.http
            .post<SuccessResponse<MessageResponse>>(`${this.messagesUrl}${messageId}/reactions`, { emoji })
            .pipe(map((r) => r.data));
    }

    /** Explicit removal, distinct from the toggle above and idempotent. */
    removeReaction(messageId: string, emoji: string): Observable<MessageResponse> {
        return this.http
            .delete<SuccessResponse<MessageResponse>>(
                `${this.messagesUrl}${messageId}/reactions/${encodeURIComponent(emoji)}`
            )
            .pipe(map((r) => r.data));
    }

    /** Role-gated server-side (open in private chats, admin/owner only in groups and channels). */
    pinMessage(messageId: string): Observable<MessageResponse> {
        return this.http
            .post<SuccessResponse<MessageResponse>>(`${this.messagesUrl}${messageId}/pin`, {})
            .pipe(map((r) => r.data));
    }

    unpinMessage(messageId: string): Observable<MessageResponse> {
        return this.http
            .post<SuccessResponse<MessageResponse>>(`${this.messagesUrl}${messageId}/unpin`, {})
            .pipe(map((r) => r.data));
    }

    getPinnedMessages(chatId: string): Observable<MessageResponse[]> {
        return this.http
            .get<SuccessResponse<MessageResponse[]>>(`${this.chatsUrl}${chatId}/pinned-messages`)
            .pipe(map((r) => r.data));
    }

    /**
     * Mute or unmute a chat for the calling user only. A future timestamp mutes until then; `null`
     * unmutes. There is no distinct "forever" flag server-side, so an indefinite mute is expressed
     * as a timestamp far enough in the future.
     */
    muteChat(chatId: string, mutedUntil: string | null): Observable<{ chat_id: string; muted_until: string | null }> {
        return this.http
            .patch<SuccessResponse<{ chat_id: string; muted_until: string | null }>>(`${this.chatsUrl}${chatId}/mute`, {
                muted_until: mutedUntil,
            })
            .pipe(map((r) => r.data));
    }

    /** ADMIN/OWNER only, rejected server-side for PRIVATE chats. Omit both bounds for no limit. */
    createInviteLink(chatId: string, expiresAt?: string, maxUses?: number): Observable<InviteLink> {
        return this.http
            .post<SuccessResponse<InviteLink>>(`${this.chatsUrl}${chatId}/invite-links`, {
                expires_at: expiresAt ?? null,
                max_uses: maxUses ?? null,
            })
            .pipe(map((r) => r.data));
    }

    /** Active links for a chat. Same ADMIN/OWNER gate as create. */
    listInviteLinks(chatId: string): Observable<InviteLink[]> {
        return this.http
            .get<SuccessResponse<InviteLink[]>>(`${this.chatsUrl}${chatId}/invite-links`)
            .pipe(map((r) => r.data));
    }

    /**
     * Preview a chat by invite-link token, without membership or roster exposure. The token is in
     * the URL here — unlike join/revoke — because this is the one meant to be a real clickable,
     * shareable link.
     */
    previewInviteLink(token: string): Observable<InviteLinkPreview> {
        return this.http
            .get<SuccessResponse<InviteLinkPreview>>(`${this.inviteLinksUrl}${encodeURIComponent(token)}`)
            .pipe(map((r) => r.data));
    }

    /**
     * Join the chat an invite link points at. The token goes in the body, not the URL — a
     * deliberate choice on the server so it never appears in an access log line for this endpoint.
     */
    joinInviteLink(token: string): Observable<InviteLinkJoinResult> {
        return this.http
            .post<SuccessResponse<InviteLinkJoinResult>>(`${this.inviteLinksUrl}join`, { token })
            .pipe(map((r) => r.data));
    }

    /** Revoke a link. Scoped server-side to the chat it belongs to, resolved from the token itself. */
    revokeInviteLink(token: string): Observable<InviteLink> {
        return this.http
            .post<SuccessResponse<InviteLink>>(`${this.inviteLinksUrl}revoke`, { token })
            .pipe(map((r) => r.data));
    }
}
