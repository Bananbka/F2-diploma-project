import { HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

import { signChannelPost, verifyChannelPost } from '../crypto/channel';
import { openMessage, sealMessage } from '../crypto/envelope';
import { b64uDecode, fromUtf8, utf8 } from '../crypto/primitives';
import { ChatKeys, ForwardOrigin, MessageAttachment, MessageReaction, MessageResponse } from '../models/crypto.model';
import { ChatApiService } from './chat-api.service';
import { CryptoApiService } from './crypto-api.service';
import { isCryptoNotEnabled } from './crypto-errors';
import { KeyStoreService } from './key-store.service';

/** How a message rendered out — the UI needs to distinguish these, not just show text or nothing. */
export type DecryptStatus =
    | 'ok'
    | 'no_key' // we hold no grant for this sender's chain yet
    | 'unverified' // decrypted, but the signature did not verify
    | 'failed' // decryption failed outright
    | 'plaintext' // legacy unencrypted, or a channel post
    | 'legacy'; // pre-migration RSA content we cannot read

export interface DecryptedMessage {
    id: string;
    chatId: string;
    senderId: string;
    createdAt: string;
    text: string | null;
    status: DecryptStatus;
    isEdited: boolean;
    /** The message this one answers, if any. Server-persisted all along; only the UI was missing. */
    replyToId: string | null;
    /** Present when this is a forwarded copy. Unverifiable — see ForwardOrigin. */
    forwardedFrom: ForwardOrigin | null;
    attachments: MessageAttachment[];
    /** True only when a signature was checked and passed. */
    senderVerified: boolean;
    /**
     * Plaintext metadata, not sealed content — reactions and pins are never part of the envelope,
     * so they are attached here rather than derived from decryption.
     */
    reactions: MessageReaction[];
    isPinned: boolean;
}

/** A page of history, ciphertext included so undecryptable entries can be retried in place. */
export interface LoadedMessages {
    raw: MessageResponse[];
    messages: DecryptedMessage[];
}

@Injectable({ providedIn: 'root' })
export class MessageService {
    private readonly chatApi = inject(ChatApiService);
    private readonly cryptoApi = inject(CryptoApiService);
    private readonly keyStore = inject(KeyStoreService);

    /**
     * Plaintext for messages already opened this session, keyed by message id.
     *
     * Memory-only and never persisted: this is the decrypted content, so writing it to disk would
     * give away exactly what the ratchet's forward secrecy is protecting.
     */
    private readonly opened = new Map<string, DecryptedMessage>();

    /**
     * The freshest known reaction/pin state for a message, keyed by id, independent of whether
     * `opened` holds a cache entry yet.
     *
     * A `message_reaction_added`/`message_pinned` event can land while that message's first
     * `decrypt()` is still in flight (own just-sent message, or a WS event interleaving with the
     * sequential decrypt loop in `loadMessages`). `patchMeta` used to no-op on a cache miss, so that
     * update was lost the moment `decryptOnce` resolved and cached a `DecryptedMessage` built from
     * its own, older `reactions`/`is_pinned`. Recording every meta update here first — regardless of
     * cache state — lets `decrypt()` overlay the latest value once `decryptOnce` finally resolves,
     * right before it caches the result. Cleared alongside `opened` so it never outlives the
     * plaintext it describes.
     */
    private readonly metaOverrides = new Map<string, { reactions: MessageReaction[]; isPinned: boolean }>();

    /**
     * Encrypt and send.
     *
     * On EPOCH_STALE the chat re-keyed between composing and sending — usually because someone
     * left. The old ciphertext must not be retried as-is: it is bound to the previous epoch and
     * would be readable by whoever just departed. So we discard the cached chain, mint a fresh one
     * for the new epoch, and re-encrypt from plaintext.
     */
    async sendText(
        chatId: string,
        text: string,
        replyTo?: string,
        attachments?: MessageAttachment[],
        forwardedFrom?: ForwardOrigin
    ): Promise<MessageResponse> {
        const keys = await firstValueFrom(this.cryptoApi.getChatKeys(chatId));

        try {
            return await this.sealAndSend(chatId, keys.current_epoch, text, replyTo, attachments, forwardedFrom);
        } catch (error) {
            if (!this.isEpochStale(error)) {
                throw error;
            }

            const currentEpoch =
                this.epochFromError(error) ?? (await firstValueFrom(this.cryptoApi.getChatKeys(chatId))).current_epoch;

            this.keyStore.invalidateSenderChain(chatId, keys.current_epoch);
            return this.sealAndSend(chatId, currentEpoch, text, replyTo, attachments, forwardedFrom);
        }
    }

    private async sealAndSend(
        chatId: string,
        epoch: number,
        text: string,
        replyTo?: string,
        attachments?: MessageAttachment[],
        forwardedFrom?: ForwardOrigin
    ): Promise<MessageResponse> {
        const identity = this.keyStore.currentIdentity;
        if (!identity) {
            throw new Error('key store is locked');
        }

        const own = await this.keyStore.ensureSenderChain(chatId, epoch);
        const { key, nonce, index } = own.chain.nextMessageKey();

        const envelope = await sealMessage({
            messageKey: key,
            nonce,
            signingPrivate: own.chainSigningPrivate,
            chatId,
            epoch,
            senderId: identity.userId,
            senderKeyId: own.senderKeyId,
            chainIndex: index,
            plaintext: utf8(text),
        });

        return firstValueFrom(this.chatApi.sendEnvelope(chatId, envelope, replyTo, attachments, forwardedFrom));
    }

    /**
     * Edit a message, sealing the replacement under a **fresh** chain index.
     *
     * Never re-seal at the original index. The message key for an index is derived once, so reusing
     * it would repeat a (key, nonce) pair under AES-GCM — which leaks the XOR of both plaintexts and
     * can expose the authentication subkey. The server enforces `idx > stored idx` for exactly that
     * reason; taking the next index from our own sending chain satisfies it naturally.
     */
    async editText(chatId: string, messageId: string, text: string): Promise<DecryptedMessage> {
        const keys = await firstValueFrom(this.cryptoApi.getChatKeys(chatId));
        const identity = this.keyStore.currentIdentity;
        if (!identity) {
            throw new Error('key store is locked');
        }

        const own = await this.keyStore.ensureSenderChain(chatId, keys.current_epoch);
        const { key, nonce, index } = own.chain.nextMessageKey();

        const envelope = await sealMessage({
            messageKey: key,
            nonce,
            signingPrivate: own.chainSigningPrivate,
            chatId,
            epoch: keys.current_epoch,
            senderId: identity.userId,
            senderKeyId: own.senderKeyId,
            chainIndex: index,
            plaintext: utf8(text),
        });

        const updated = await firstValueFrom(this.chatApi.editMessage(messageId, envelope));

        // The stored plaintext is now the previous version; replace rather than leave it stale.
        this.opened.delete(messageId);
        return this.recordOutgoing(updated, text);
    }

    /** Post to a channel: signed with the identity key, not encrypted. */
    async sendChannelPost(chatId: string, content: string): Promise<MessageResponse> {
        const identity = this.keyStore.currentIdentity;
        if (!identity) {
            throw new Error('key store is locked');
        }

        const postId = uuidv4();

        return firstValueFrom(
            this.chatApi.sendChannelPost(chatId, {
                v: 1,
                alg: 'ed25519-post-v1',
                post_id: postId,
                content,
                sig: signChannelPost({
                    signingPrivate: identity.signingPrivate,
                    chatId,
                    senderId: identity.userId,
                    postId,
                    content,
                }),
            })
        );
    }

    /**
     * Fetch and decrypt a chat's history.
     *
     * Grants are ingested first so chains exist before we walk the messages; otherwise every
     * message from a sender we have not seen would report no_key on first load.
     */
    async loadMessages(chatId: string, limit = 50, beforeId?: string): Promise<LoadedMessages> {
        // A chat need not have crypto settings at all: channels are signed rather than encrypted, and
        // a private chat has none until encryption is enabled for it. Neither is an error — there are
        // simply no grants to ingest, and `decrypt` reports anything it cannot open as `no_key`
        // rather than pretending to have read it.
        const keys = await this.tryGetChatKeys(chatId);
        if (keys) {
            await this.keyStore.ingestDistributions(chatId, keys.distributions);
        }

        // `GET /chats/{id}/messages` sorts by _id descending, because "the latest N" is only
        // expressible that way with a limit. Reverse into chronological order here: the ratchet is
        // ordered, so decrypting newest-first walks a receiver chain backwards and every message
        // after the first reports a consumed index. Rendering and back-pagination both want
        // ascending order too.
        const raw = (await firstValueFrom(this.chatApi.getMessages(chatId, limit, beforeId))).slice().reverse();

        // The ciphertext is handed back too. A message that decrypts to no_key today may be
        // decryptable in a second, and re-running it needs the envelope, not another round trip.
        const messages: DecryptedMessage[] = [];
        for (const message of raw) {
            // Sequential, not Promise.all: concurrent decryption of one sender's chain interleaves
            // the ratchet's index advances.
            messages.push(await this.decrypt(chatId, message));
        }

        return { raw, messages };
    }

    /**
     * Re-fetch this chat's distributions and ingest any we do not already hold.
     *
     * The cure for `no_key`. A sender mints a new chain whenever their in-memory state is gone —
     * after a reload, or when an epoch opens — and publishes it as a new distribution. Until we
     * fetch that distribution we hold no chain for the `skid` their messages carry, so they decrypt
     * to `no_key`. Nothing arrives over the socket to tell us; the grants have to be pulled.
     */
    async refreshGrants(chatId: string): Promise<void> {
        const keys = await this.tryGetChatKeys(chatId);
        if (keys) {
            await this.keyStore.ingestDistributions(chatId, keys.distributions);
        }
    }

    /** Chat keys, or null when the chat has no crypto settings. Other failures still throw. */
    private async tryGetChatKeys(chatId: string): Promise<ChatKeys | null> {
        try {
            return await firstValueFrom(this.cryptoApi.getChatKeys(chatId));
        } catch (error) {
            if (isCryptoNotEnabled(error)) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Open one message, at most once.
     *
     * The ratchet is deliberately single-use: `ReceiverChain.messageKeyFor` derives a key, drops the
     * chain key behind it, and throws for any index it has already passed. That is forward secrecy
     * working — the key that opened a message genuinely no longer exists.
     *
     * So the plaintext has to be kept, because the ciphertext can never be opened a second time.
     * Without this cache, merely re-rendering a conversation (reopening it, or paging back over
     * messages already read live on the socket) would decrypt each message again and report `failed`
     * with "a consumed chain index" — indistinguishable, to the reader, from tampering.
     *
     * `no_key` is deliberately not cached: nothing was consumed, and the whole point is that it
     * becomes readable once the grant arrives.
     */
    async decrypt(chatId: string, message: MessageResponse): Promise<DecryptedMessage> {
        const cached = this.opened.get(message._id);
        if (cached) {
            return cached;
        }

        const result = await this.decryptOnce(chatId, message);

        // `decryptOnce` awaits real crypto work, so a `patchMeta` call can land on the side-map
        // at any point during that wait. Overlaying here, right before caching, is the latest
        // possible read and so the one least likely to lose a concurrent update.
        const withMeta = this.applyMetaOverride(result);
        if (withMeta.status !== 'no_key') {
            this.opened.set(message._id, withMeta);
        }
        return withMeta;
    }

    private applyMetaOverride(result: DecryptedMessage): DecryptedMessage {
        const override = this.metaOverrides.get(result.id);
        if (!override) {
            return result;
        }
        return { ...result, reactions: override.reactions, isPinned: override.isPinned };
    }

    /** Drop retained plaintext. Called when the key store closes; holding it open would outlive it. */
    forgetOpened(): void {
        this.opened.clear();
        this.metaOverrides.clear();
    }

    /**
     * Forget one message's plaintext.
     *
     * Needed when a message is edited: the ciphertext behind that id has changed, so the cached
     * plaintext is now the old content and returning it would show a stale edit forever.
     */
    forgetOne(messageId: string): void {
        this.opened.delete(messageId);
        this.metaOverrides.delete(messageId);
    }

    /**
     * Apply a reaction/pin change without re-decrypting.
     *
     * Reactions and pins are plaintext metadata carried on the same document, but the content
     * itself has not changed — re-running `decrypt` would either return the stale cached entry (for
     * a message we already opened) or, worse, attempt to open the envelope again.
     *
     * Recorded into `metaOverrides` unconditionally, so an update that arrives before this
     * message's first `decrypt()` resolves is not lost — `decrypt()` overlays it once `decryptOnce`
     * finally resolves and it caches the result. If `opened` already holds this message, it is
     * patched in place too and the caller gets the patched result back immediately; otherwise there
     * is nothing to render yet and the caller falls back to whatever it already has.
     */
    patchMeta(raw: MessageResponse): DecryptedMessage | null {
        this.metaOverrides.set(raw._id, { reactions: raw.reactions ?? [], isPinned: raw.is_pinned });

        const cached = this.opened.get(raw._id);
        if (!cached) {
            return null;
        }

        const updated: DecryptedMessage = {
            ...cached,
            reactions: raw.reactions ?? [],
            isPinned: raw.is_pinned,
        };
        this.opened.set(raw._id, updated);
        return updated;
    }

    /**
     * Record a message we just sent, using the plaintext we already have.
     *
     * Our own message must never be run through `decrypt`. We seal with a `SenderChain` and would
     * have to open with a separate `ReceiverChain` built from the grant we wrapped for ourselves —
     * consuming an index there for no reason, and reporting `no_key` in the window before that grant
     * has been fetched back. Both are avoidable: the plaintext never left this process.
     */
    recordOutgoing(sent: MessageResponse, plaintext: string): DecryptedMessage {
        const message: DecryptedMessage = {
            id: sent._id,
            chatId: sent.chat_id,
            senderId: sent.sender_id,
            createdAt: sent.created_at,
            isEdited: sent.is_edited,
            replyToId: sent.reply_to_message_id,
            forwardedFrom: sent.forwarded_from,
            attachments: sent.attachments ?? [],
            text: plaintext,
            status: sent.content_format === 'channel_signed_v1' ? 'plaintext' : 'ok',
            // We signed it ourselves, so authorship is known rather than merely checked.
            senderVerified: true,
            reactions: sent.reactions ?? [],
            isPinned: sent.is_pinned,
        };

        this.opened.set(sent._id, message);
        return message;
    }

    private async decryptOnce(chatId: string, message: MessageResponse): Promise<DecryptedMessage> {
        // `reactions`/`isPinned` here reflect this particular `MessageResponse` instance only.
        // `decrypt()` overlays `metaOverrides` afterwards, once this (possibly slow, real-crypto)
        // call has actually resolved, so a `patchMeta` racing this decrypt is not lost.
        const base = {
            id: message._id,
            chatId: message.chat_id,
            senderId: message.sender_id,
            createdAt: message.created_at,
            isEdited: message.is_edited,
            replyToId: message.reply_to_message_id,
            forwardedFrom: message.forwarded_from,
            attachments: message.attachments ?? [],
            reactions: message.reactions ?? [],
            isPinned: message.is_pinned,
        };

        if (message.content_format === 'channel_signed_v1' && message.channel_post) {
            // Readable by design. What matters is whether the author is who the post claims.
            const senderKeys = await firstValueFrom(this.cryptoApi.getKeysBatch([message.sender_id]));
            const verified =
                senderKeys.length > 0 &&
                verifyChannelPost({
                    signingPublic: b64uDecode(senderKeys[0].signing_public_key),
                    signature: message.channel_post.sig,
                    chatId,
                    senderId: message.sender_id,
                    postId: message.channel_post.post_id,
                    content: message.channel_post.content,
                });

            return {
                ...base,
                text: message.channel_post.content,
                status: 'plaintext',
                senderVerified: verified,
            };
        }

        if (message.content_format === 'legacy_plaintext') {
            return { ...base, text: message.encrypted_content, status: 'plaintext', senderVerified: false };
        }

        if (message.content_format === 'legacy_rsa') {
            return { ...base, text: null, status: 'legacy', senderVerified: false };
        }

        const envelope = message.envelope;
        if (!envelope) {
            return { ...base, text: null, status: 'failed', senderVerified: false };
        }

        const chain = this.keyStore.getReceiverChain(chatId, envelope.epoch, envelope.skid);
        if (!chain) {
            // Not a failure: the sender simply has not wrapped their chain for us yet.
            return { ...base, text: null, status: 'no_key', senderVerified: false };
        }

        const signingPublic = this.keyStore.getChainSigningKey(envelope.skid);

        try {
            const messageKey = chain.messageKeyFor(envelope.idx);
            const plaintext = await openMessage({
                messageKey: messageKey.key,
                envelope,
                chatId,
                senderId: message.sender_id,
                signingPublic,
            });

            return { ...base, text: fromUtf8(plaintext), status: 'ok', senderVerified: Boolean(signingPublic) };
        } catch {
            // Could be a consumed index, a stale grant, or genuine tampering. The UI must not
            // present any of those as ordinary text.
            return { ...base, text: null, status: 'failed', senderVerified: false };
        }
    }

    private isEpochStale(error: unknown): boolean {
        return error instanceof HttpErrorResponse && error.status === 409 && error.error?.error_code === 'EPOCH_STALE';
    }

    private epochFromError(error: unknown): number | null {
        if (error instanceof HttpErrorResponse) {
            const current = error.error?.details?.current_epoch;
            return typeof current === 'number' ? current : null;
        }
        return null;
    }
}
