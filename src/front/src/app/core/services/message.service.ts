import { HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

import { signChannelPost, verifyChannelPost } from '../crypto/channel';
import { openMessage, sealMessage } from '../crypto/envelope';
import { b64uDecode, b64uEncode, fromUtf8, utf8 } from '../crypto/primitives';
import {
    ChatKeys,
    ForwardOrigin,
    MessageAttachment,
    MessageReaction,
    MessageResponse,
    PublicKey,
} from '../models/crypto.model';
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

/**
 * The envelope's plaintext, as JSON rather than bare text.
 *
 * Carrying attachment keys inside the already-sealed envelope (rather than a new wire primitive)
 * means a recipient can only ever learn a key by first passing every check that gates opening the
 * message itself — member-set verification, signature, epoch binding. See
 * `docs/crypto-spec-v1.md` §4.5.
 */
interface MessagePlaintext {
    text: string;
    attachmentKeys: { url: string; key: string }[];
}

/** Build the JSON plaintext payload sealed inside a message envelope. */
function buildPlaintext(text: string, attachments: MessageAttachment[] | undefined): Uint8Array {
    const attachmentKeys = (attachments ?? [])
        .filter((file): file is MessageAttachment & { decryptionKey: Uint8Array } => file.decryptionKey !== undefined)
        .map((file) => ({ url: file.url, key: b64uEncode(file.decryptionKey) }));

    const payload: MessagePlaintext = { text, attachmentKeys };
    return utf8(JSON.stringify(payload));
}

/**
 * Parse a decrypted envelope's plaintext.
 *
 * Message history sealed before this feature existed is raw UTF-8 text, not JSON — attempting to
 * `JSON.parse` it either throws or (worse, for a plaintext that happens to look numeric or
 * boolean) succeeds as the wrong shape. Either case falls back to treating the bytes as legacy
 * plain text with no attachment keys, so old history keeps decrypting exactly as it always has.
 */
function parsePlaintext(plaintext: Uint8Array): MessagePlaintext {
    const raw = fromUtf8(plaintext);

    try {
        const parsed = JSON.parse(raw);
        if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.text === 'string' &&
            Array.isArray(parsed.attachmentKeys)
        ) {
            return parsed as MessagePlaintext;
        }
    } catch {
        // Not JSON at all — legacy plaintext. Fall through.
    }

    return { text: raw, attachmentKeys: [] };
}

/**
 * Refuse to seal an edit that would silently orphan an attachment.
 *
 * `buildPlaintext` filters out any attachment missing a `decryptionKey` when it builds
 * `attachmentKeys` — but the wire-bound attachment list (via `stripDecryptionKeys`) still lists
 * that same attachment by url/metadata. If such an attachment is kept across an edit, the edit
 * would re-persist it with no key anywhere: the key only ever travels inside the sealed envelope
 * plaintext, and this edit would overwrite that plaintext without one, permanently. The caller
 * must drop the attachment (or recover its key) before editing, not silently lose it.
 *
 * Stickers are exempt, matching `buildPlaintext`'s own filter: they are public, unencrypted
 * images from the sticker-packs bucket and never carry a `decryptionKey` by design (see
 * `onStickerPicked()` in `composer.component.ts`), so requiring one here would make editing any
 * message that happens to carry a sticker impossible — even a pure text-only edit.
 */
function assertAttachmentsKeyed(attachments: MessageAttachment[] | undefined): void {
    const unkeyed = (attachments ?? []).find((file) => file.kind !== 'sticker' && file.decryptionKey === undefined);
    if (unkeyed) {
        throw new Error(
            `Cannot edit: attachment "${unkeyed.name}" has no decryption key and would become permanently unreadable`
        );
    }
}

/** Strip `decryptionKey` before an attachment list is sent over HTTP — it never belongs there. */
function stripDecryptionKeys(attachments: MessageAttachment[]): MessageAttachment[] {
    return attachments.map((file) => {
        const copy = { ...file };
        delete copy.decryptionKey;
        return copy;
    });
}

/** Attach each decrypted key to the matching attachment by URL, leaving the rest untouched. */
function withAttachmentKeys(
    attachments: MessageAttachment[],
    attachmentKeys: MessagePlaintext['attachmentKeys']
): MessageAttachment[] {
    if (attachmentKeys.length === 0) {
        return attachments;
    }

    const keysByUrl = new Map(attachmentKeys.map((entry) => [entry.url, b64uDecode(entry.key)]));
    return attachments.map((file) => {
        const key = keysByUrl.get(file.url);
        return key ? { ...file, decryptionKey: key } : file;
    });
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
            plaintext: buildPlaintext(text, attachments),
        });

        // The key only ever belongs inside the sealed plaintext above — it must never reach the
        // wire as part of the ordinary HTTP attachment metadata.
        const wireAttachments = attachments ? stripDecryptionKeys(attachments) : undefined;
        return firstValueFrom(this.chatApi.sendEnvelope(chatId, envelope, replyTo, wireAttachments, forwardedFrom));
    }

    /**
     * Edit a message, sealing the replacement under a **fresh** chain index.
     *
     * Never re-seal at the original index. The message key for an index is derived once, so reusing
     * it would repeat a (key, nonce) pair under AES-GCM — which leaks the XOR of both plaintexts and
     * can expose the authentication subkey. The server enforces `idx > stored idx` for exactly that
     * reason; taking the next index from our own sending chain satisfies it naturally.
     *
     * `attachments` is the caller's CURRENT attachment list for this message, after any add/remove
     * made during this edit session — not necessarily the original, unchanged list. `PUT
     * /messages/{id}` now accepts an `attachments` field (omit it to leave the stored list
     * untouched, supply a list — possibly `[]` — to replace it wholesale), so this method both
     * re-seals the plaintext under a fresh chain index *and* asks the server to persist the new
     * attachment list.
     *
     * Each attachment here must already carry the key a recipient needs: an attachment that
     * survived from before the edit keeps the `decryptionKey` it was decrypted with, and one added
     * during this edit session carries the fresh key it was encrypted under (`encryptAttachment`,
     * same as a brand-new send). Those keys are folded into the envelope's own sealed plaintext via
     * `buildPlaintext`, then stripped before the attachment list is sent over HTTP — the key must
     * never appear as ordinary attachment metadata. Enforced by `assertAttachmentsKeyed`: an
     * attachment missing its `decryptionKey` throws rather than being silently sealed without one.
     */
    async editText(
        chatId: string,
        messageId: string,
        text: string,
        attachments?: MessageAttachment[]
    ): Promise<DecryptedMessage> {
        const keys = await firstValueFrom(this.cryptoApi.getChatKeys(chatId));
        const identity = this.keyStore.currentIdentity;
        if (!identity) {
            throw new Error('key store is locked');
        }

        // Every kept attachment must carry the key a recipient needs before we seal — see
        // `assertAttachmentsKeyed`. Checked before building the plaintext, not after, so a missing
        // key is a loud, recoverable failure rather than a silent, permanent one.
        assertAttachmentsKeyed(attachments);

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
            plaintext: buildPlaintext(text, attachments),
        });

        // The key only ever belongs inside the sealed plaintext above — it must never reach the
        // wire as part of the ordinary HTTP attachment metadata.
        const wireAttachments = attachments ? stripDecryptionKeys(attachments) : undefined;
        const updated = await firstValueFrom(this.chatApi.editMessage(messageId, envelope, wireAttachments));

        // The stored plaintext is now the previous version; replace rather than leave it stale.
        this.opened.delete(messageId);
        return this.recordOutgoing(updated, text, attachments);
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
     *
     * `knownKeys` lets a caller that already fetched this chat's keys (e.g. `ChatStoreService.openChat`,
     * right after `ensureEncryptionEnabled`) pass them through instead of this method fetching them
     * again. Pass `undefined` (the default) to have this method fetch them itself — the right choice
     * for any caller without a fresher copy already in hand. Pass `null` explicitly to mean "already
     * checked, this chat has no crypto settings" and skip the fetch entirely without treating it as
     * unknown.
     */
    async loadMessages(
        chatId: string,
        limit = 50,
        beforeId?: string,
        knownKeys?: ChatKeys | null
    ): Promise<LoadedMessages> {
        // A chat need not have crypto settings at all: channels are signed rather than encrypted, and
        // a private chat has none until encryption is enabled for it. Neither is an error — there are
        // simply no grants to ingest, and `decrypt` reports anything it cannot open as `no_key`
        // rather than pretending to have read it.
        const keys = knownKeys !== undefined ? knownKeys : await this.tryGetChatKeys(chatId);
        if (keys) {
            await this.keyStore.ingestDistributions(chatId, keys.distributions);
        }

        // `GET /chats/{id}/messages` sorts by _id descending, because "the latest N" is only
        // expressible that way with a limit. Reverse into chronological order here: the ratchet is
        // ordered, so decrypting newest-first walks a receiver chain backwards and every message
        // after the first reports a consumed index. Rendering and back-pagination both want
        // ascending order too.
        const raw = (await firstValueFrom(this.chatApi.getMessages(chatId, limit, beforeId))).slice().reverse();

        // Channel posts are verified against the sender's signing key, fetched via the same
        // `keys/batch` endpoint regardless of how many posts in this page share a sender — one
        // round trip for the whole page rather than one per post.
        const channelSenderIds = Array.from(
            new Set(
                raw
                    .filter((message) => message.content_format === 'channel_signed_v1' && message.channel_post)
                    .map((message) => message.sender_id)
            )
        );
        const senderKeys = channelSenderIds.length > 0 ? await this.getKeysBatchMap(channelSenderIds) : undefined;

        // The ciphertext is handed back too. A message that decrypts to no_key today may be
        // decryptable in a second, and re-running it needs the envelope, not another round trip.
        const messages: DecryptedMessage[] = [];
        for (const message of raw) {
            // Sequential, not Promise.all: concurrent decryption of one sender's chain interleaves
            // the ratchet's index advances.
            messages.push(await this.decrypt(chatId, message, senderKeys));
        }

        return { raw, messages };
    }

    /** One `keys/batch` round trip for several senders at once, keyed by `user_id`. */
    private async getKeysBatchMap(userIds: string[]): Promise<Map<string, PublicKey>> {
        const keys = await firstValueFrom(this.cryptoApi.getKeysBatch(userIds));
        return new Map(keys.map((key) => [key.user_id, key]));
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
    async decrypt(
        chatId: string,
        message: MessageResponse,
        senderKeys?: Map<string, PublicKey>
    ): Promise<DecryptedMessage> {
        const cached = this.opened.get(message._id);
        if (cached) {
            return cached;
        }

        const result = await this.decryptOnce(chatId, message, senderKeys);

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
     *
     * `sentAttachments` is the locally-held list carrying each attachment's `decryptionKey` — the
     * keys never travel over HTTP, so `sent.attachments` (the server's echo) never has them. Matched
     * back onto the server's copy by URL so the rendered attachments carry the fields the server
     * knows (size, kind, etc.) *and* the key only this process ever held.
     */
    recordOutgoing(sent: MessageResponse, plaintext: string, sentAttachments?: MessageAttachment[]): DecryptedMessage {
        const keysByUrl = new Map(
            (sentAttachments ?? [])
                .filter((f): f is MessageAttachment & { decryptionKey: Uint8Array } => f.decryptionKey !== undefined)
                .map((f) => [f.url, f.decryptionKey] as const)
        );
        const attachments = (sent.attachments ?? []).map((file) => {
            const key = keysByUrl.get(file.url);
            return key ? { ...file, decryptionKey: key } : file;
        });

        const message: DecryptedMessage = {
            id: sent._id,
            chatId: sent.chat_id,
            senderId: sent.sender_id,
            createdAt: sent.created_at,
            isEdited: sent.is_edited,
            replyToId: sent.reply_to_message_id,
            forwardedFrom: sent.forwarded_from,
            attachments,
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

    private async decryptOnce(
        chatId: string,
        message: MessageResponse,
        senderKeys?: Map<string, PublicKey>
    ): Promise<DecryptedMessage> {
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
            //
            // `senderKeys` lets a page-level caller (`loadMessages`) supply every sender's key from
            // one batched `keys/batch` call instead of this method making its own per-message round
            // trip. A caller decrypting a single message in isolation (e.g. one arriving live over
            // the socket) omits it and this falls back to fetching just this one sender's key itself.
            const senderKey = senderKeys
                ? senderKeys.get(message.sender_id)
                : (await firstValueFrom(this.cryptoApi.getKeysBatch([message.sender_id])))[0];
            const verified =
                senderKey !== undefined &&
                verifyChannelPost({
                    signingPublic: b64uDecode(senderKey.signing_public_key),
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

            const parsed = parsePlaintext(plaintext);
            return {
                ...base,
                attachments: withAttachmentKeys(base.attachments, parsed.attachmentKeys),
                text: parsed.text,
                status: 'ok',
                senderVerified: Boolean(signingPublic),
            };
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
