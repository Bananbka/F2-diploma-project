import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

import {
    computeMemberSetHash,
    SENDER_KEY_ALGORITHM,
    signDistribution,
    unwrapChainKey,
    verifyDistribution,
    WRAP_ALGORITHM,
    wrapChainKey,
} from '../crypto/grants';
import { generateIdentity, unwrapPrivateBundle, WrappedBundle, wrapPrivateBundle } from '../crypto/identity';
import { b64uDecode, b64uEncode } from '../crypto/primitives';
import { generateChainKey, ReceiverChain, SenderChain } from '../crypto/ratchet';
import { Distribution, GrantUpload, OwnIdentity } from '../models/crypto.model';
import { CryptoApiService } from './crypto-api.service';

const DEVICE_ID_KEY = 'ns.device_id';

interface UnlockedIdentity {
    userId: string;
    deviceId: string;
    signingPrivate: Uint8Array;
    signingPublic: Uint8Array;
    identityPrivate: Uint8Array;
}

/**
 * The observable milestones of an unlock. These are real stages, not interpolated percentages —
 * Argon2id offers no progress callback, and inventing one would misrepresent how far along we are.
 */
export type UnlockStage = 'fetching' | 'deriving' | 'opening';

export type UnlockStageReporter = (stage: UnlockStage) => void | Promise<void>;

/** A chain we own and send on, for one (chat, epoch). */
interface OwnChain {
    senderKeyId: string;
    chain: SenderChain;
    chainSigningPrivate: Uint8Array;
}

/**
 * Holds unlocked key material and ratchet state for the session.
 *
 * Everything here lives in memory only. The private bundle is re-fetched and re-unwrapped from the
 * password on each login rather than cached in localStorage, because anything persisted in a
 * browser is reachable by XSS — and a stolen identity key means impersonation plus retroactive
 * decryption of every message the attacker also captured.
 *
 * Re-entering the password after a reload is therefore the intended cost, not a defect. Persisting
 * the bundle under a non-extractable IndexedDB key was tried and reverted: it lowers the bar from
 * "read the storage" to "execute code in the origin", which is an improvement over localStorage but
 * still weaker than holding nothing at all.
 *
 * The cost is that chain state does not survive a reload: on refresh we re-fetch grants and
 * rebuild receiver chains from their start index. That is correct but re-derives keys, which is
 * why a production client would persist chains in IndexedDB under a key wrapped by the KEK.
 */
@Injectable({ providedIn: 'root' })
export class KeyStoreService {
    private readonly cryptoApi = inject(CryptoApiService);

    private identity: UnlockedIdentity | null = null;

    /** (chatId, epoch) -> our sending chain */
    private readonly ownChains = new Map<string, OwnChain>();
    /** (chatId, epoch, senderKeyId) -> receiving chain */
    private readonly peerChains = new Map<string, ReceiverChain>();
    /** senderKeyId -> the chain's Ed25519 public key, for verifying message signatures */
    private readonly chainSigningKeys = new Map<string, Uint8Array>();

    readonly isUnlocked = signal(false);

    get deviceId(): string {
        let stored = localStorage.getItem(DEVICE_ID_KEY);
        if (!stored) {
            // The client owns this id because it signs over it; a server-assigned one would need
            // a second round trip to sign something the client could not know in advance.
            stored = uuidv4();
            localStorage.setItem(DEVICE_ID_KEY, stored);
        }
        return stored;
    }

    get currentIdentity(): UnlockedIdentity | null {
        return this.identity;
    }

    /** Create and publish a fresh identity for this device. Called once, at registration. */
    async createAndPublishIdentity(userId: string, password: string, displayName = 'web'): Promise<void> {
        const deviceId = this.deviceId;
        const bundle = generateIdentity(userId, deviceId);
        const wrapped = await wrapPrivateBundle(bundle, password);

        await firstValueFrom(
            this.cryptoApi.publishIdentity({
                device_id: deviceId,
                display_name: displayName,
                identity_public_key: b64uEncode(bundle.identityPublic),
                signing_public_key: b64uEncode(bundle.signingPublic),
                identity_key_signature: b64uEncode(bundle.identityKeySignature),
                encrypted_private_bundle: wrapped.encryptedPrivateBundle,
                kdf_params: wrapped.kdfParams as unknown as Record<string, unknown>,
            })
        );

        this.identity = {
            userId,
            deviceId,
            signingPrivate: bundle.signingPrivate,
            signingPublic: bundle.signingPublic,
            identityPrivate: bundle.identityPrivate,
        };
        this.isUnlocked.set(true);
    }

    /**
     * Unlock the stored private bundle with the user's password.
     *
     * Argon2id at 64 MiB is deliberately slow — that cost is what protects the bundle if the
     * database is ever disclosed. Callers should show a spinner rather than assume it is instant.
     *
     * `onStage` reports the real milestones so the UI can show honest progress. It is awaited
     * between stages because the derivation is synchronous and blocks the main thread: without
     * yielding, the stage that is about to run would never paint.
     */
    async unlock(userId: string, password: string, onStage?: UnlockStageReporter): Promise<boolean> {
        await onStage?.('fetching');
        const identities = await firstValueFrom(this.cryptoApi.getOwnIdentities());
        const mine = identities.find((i) => i.device_id === this.deviceId) ?? identities[0];

        if (!mine) {
            return false;
        }

        try {
            await onStage?.('deriving');
            const opened = await unwrapPrivateBundle(mine.encrypted_private_bundle, mine.kdf_params as never, password);
            await onStage?.('opening');

            this.identity = {
                userId,
                deviceId: mine.device_id,
                signingPrivate: opened.signingPrivate,
                signingPublic: b64uDecode(mine.signing_public_key),
                identityPrivate: opened.identityPrivate,
            };
            this.isUnlocked.set(true);

            return true;
        } catch {
            // A GCM tag failure here means the wrong password, not a corrupt bundle.
            return false;
        }
    }

    /**
     * Signed-prekey rotation is deliberately NOT performed by this client.
     *
     * The primitives exist and the server verifies the binding, but rotating here would break
     * receiving. Senders wrap grants to `signed_prekey_public ?? identity_public_key`, while
     * `ingestDistributions` can only unwrap with `identityPrivate` — the prekey's private half is
     * nowhere, so publishing a prekey makes every grant addressed to this device unopenable and every
     * message reports `no_key`.
     *
     * It cannot simply be kept, either. The private bundle is sealed under an Argon2id key derived
     * from the password, and the password is not retained after unlock — so re-sealing the bundle to
     * add a rotated prekey private would mean re-prompting on every rotation. Persisting it outside
     * the bundle is the approach already tried and reverted for the identity keys.
     *
     * Doing this properly needs the bundle to carry `prekey_private` from the start, generated at
     * registration alongside the identity, with rotation deferred until there is somewhere to put the
     * new private half. Until then the identity key is the grant recipient and forward secrecy across
     * prekey rotations is simply not claimed.
     */
    // (no rotation method: see above)

    /**
     * Re-seal a published device's private bundle under a new password.
     *
     * Opened with the old password and immediately re-opened with the new one before returning. That
     * second unwrap is the point: `POST /auth/change-password` accepts whatever bundle it is given
     * without being able to verify it opens, so a wrapping mistake would lock the account out with a
     * success response. Failing here instead costs nothing.
     */
    async rewrapBundleFor(published: OwnIdentity, oldPassword: string, newPassword: string): Promise<WrappedBundle> {
        const opened = await unwrapPrivateBundle(
            published.encrypted_private_bundle,
            published.kdf_params as never,
            oldPassword
        );

        const rewrapped = await wrapPrivateBundle(
            {
                signingPrivate: opened.signingPrivate,
                signingPublic: b64uDecode(published.signing_public_key),
                identityPrivate: opened.identityPrivate,
                identityPublic: b64uDecode(published.identity_public_key),
                identityKeySignature: b64uDecode(published.identity_key_signature),
            },
            newPassword
        );

        // Prove it opens before it leaves this machine.
        const verified = await unwrapPrivateBundle(rewrapped.encryptedPrivateBundle, rewrapped.kdfParams, newPassword);

        if (
            b64uEncode(verified.signingPrivate) !== b64uEncode(opened.signingPrivate) ||
            b64uEncode(verified.identityPrivate) !== b64uEncode(opened.identityPrivate)
        ) {
            throw new Error('Re-wrapped bundle did not round-trip; refusing to change the password.');
        }

        return rewrapped;
    }

    lock(): void {
        this.identity = null;
        this.ownChains.clear();
        this.peerChains.clear();
        this.chainSigningKeys.clear();
        this.isUnlocked.set(false);
    }

    private requireIdentity(): UnlockedIdentity {
        if (!this.identity) {
            throw new Error('key store is locked');
        }
        return this.identity;
    }

    /**
     * Ensure we have a published sending chain for this chat's current epoch.
     *
     * Called lazily on first send rather than at rotation time, which is what lets the server
     * allocate epochs without waiting for any client to be online.
     */
    async ensureSenderChain(chatId: string, epoch: number): Promise<OwnChain> {
        const cacheKey = `${chatId}:${epoch}`;
        const existing = this.ownChains.get(cacheKey);
        if (existing) {
            return existing;
        }

        const identity = this.requireIdentity();
        const roster = await firstValueFrom(this.cryptoApi.getRoster(chatId));

        // The anti-ghost check. If the server has quietly inserted a device into the member set,
        // the recomputed hash will not match the epoch's commitment and we refuse to hand it keys.
        // The backend stores member_set_hash but cannot enforce this — only we can.
        const recomputed = computeMemberSetHash(roster.members.map((m) => m.device_id));
        if (recomputed !== roster.member_set_hash) {
            throw new Error(
                "Member set verification failed: the server's roster does not match the epoch commitment. " +
                    'Refusing to distribute keys.'
            );
        }

        const chainKey = generateChainKey();
        const senderKeyId = uuidv4();
        const chainIdentity = generateIdentity(identity.userId, identity.deviceId);

        const grants: GrantUpload[] = [];
        for (const member of roster.members) {
            // Prefer the signed prekey: it gives forward secrecy for the grant once it rotates.
            //
            // The recipient must hold the matching private half, and this client keeps only the
            // identity private — which is why it never publishes a prekey of its own. A prekey seen
            // here therefore belongs to some other client that can open it.
            const recipientPublic = b64uDecode(member.signed_prekey_public ?? member.identity_public_key);

            const wrapped = await wrapChainKey({
                chainKey,
                chainStartIndex: 0,
                recipientPublic,
                chatId,
                epoch,
                senderKeyId,
                senderDeviceId: identity.deviceId,
                recipientDeviceId: member.device_id,
            });

            grants.push({
                recipient_device_id: member.device_id,
                wrap_algorithm: WRAP_ALGORITHM,
                ephemeral_public_key: wrapped.ephemeralPublicKey,
                wrapped_chain_key: wrapped.wrappedChainKey,
            });
        }

        await firstValueFrom(
            this.cryptoApi.publishSenderKey(chatId, epoch, {
                sender_device_id: identity.deviceId,
                sender_key_id: senderKeyId,
                algorithm: SENDER_KEY_ALGORITHM,
                signing_public_key: b64uEncode(chainIdentity.signingPublic),
                chain_start_index: 0,
                signature: signDistribution({
                    identitySigningPrivate: identity.signingPrivate,
                    chatId,
                    epoch,
                    senderKeyId,
                    chainSigningPublic: chainIdentity.signingPublic,
                    chainStartIndex: 0,
                }),
                grants,
            })
        );

        const own: OwnChain = {
            senderKeyId,
            chain: new SenderChain(chainKey),
            chainSigningPrivate: chainIdentity.signingPrivate,
        };

        this.ownChains.set(cacheKey, own);
        this.chainSigningKeys.set(senderKeyId, chainIdentity.signingPublic);
        return own;
    }

    /** Drop a cached sending chain, forcing a fresh one on next send (used after EPOCH_STALE). */
    invalidateSenderChain(chatId: string, epoch: number): void {
        this.ownChains.delete(`${chatId}:${epoch}`);
    }

    /** Unwrap every grant addressed to us and build the matching receiver chains. */
    async ingestDistributions(chatId: string, distributions: Distribution[]): Promise<void> {
        const identity = this.requireIdentity();

        for (const dist of distributions) {
            const cacheKey = `${chatId}:${dist.epoch}:${dist.sender_key_id}`;
            if (this.peerChains.has(cacheKey) || !dist.grant) {
                continue;
            }

            // Verify the sender's long-term key vouches for this chain before trusting it.
            const senderKeys = await firstValueFrom(this.cryptoApi.getKeysBatch([dist.sender_user_id]));
            const senderKey = senderKeys.find((k) => k.device_id === dist.sender_device_id);

            if (
                senderKey &&
                !verifyDistribution({
                    identitySigningPublic: b64uDecode(senderKey.signing_public_key),
                    signature: dist.signature,
                    chatId,
                    epoch: dist.epoch,
                    senderKeyId: dist.sender_key_id,
                    chainSigningPublic: b64uDecode(dist.signing_public_key),
                    chainStartIndex: dist.chain_start_index,
                })
            ) {
                // A forged distribution: skip it rather than decrypt messages we cannot attribute.
                continue;
            }

            try {
                const { chainKey, chainStartIndex } = await unwrapChainKey({
                    wrapped: dist.grant.wrapped_chain_key,
                    ephemeralPublic: dist.grant.ephemeral_public_key,
                    recipientPrivate: identity.identityPrivate,
                    chatId,
                    epoch: dist.epoch,
                    senderKeyId: dist.sender_key_id,
                    senderDeviceId: dist.sender_device_id,
                    recipientDeviceId: identity.deviceId,
                });

                this.peerChains.set(cacheKey, new ReceiverChain(chainKey, chainStartIndex));
                this.chainSigningKeys.set(dist.sender_key_id, b64uDecode(dist.signing_public_key));
            } catch {
                // Stale grant, wrapped to an identity key we have since rotated away from.
                continue;
            }
        }
    }

    getReceiverChain(chatId: string, epoch: number, senderKeyId: string): ReceiverChain | undefined {
        return this.peerChains.get(`${chatId}:${epoch}:${senderKeyId}`);
    }

    getChainSigningKey(senderKeyId: string): Uint8Array | undefined {
        return this.chainSigningKeys.get(senderKeyId);
    }
}
