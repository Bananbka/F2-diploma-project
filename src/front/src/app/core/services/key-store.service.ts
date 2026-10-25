import { inject, Injectable, InjectionToken, signal } from '@angular/core';
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
import {
    generateIdentity,
    generateSignedPrekey,
    KdfParams,
    safetyNumber,
    sealPrivateBundle,
    unwrapPrivateBundle,
    userFingerprintMaterial,
    verifyIdentityBinding,
    verifySignedPrekey,
    WrappedBundle,
    wrapPrivateBundle,
} from '../crypto/identity';
import { b64uDecode, b64uEncode } from '../crypto/primitives';
import { generateChainKey, MessageKey, ReceiverChain, SenderChain } from '../crypto/ratchet';
import { unwrapSkippedKey, wrapSkippedKey } from '../crypto/skipped-wrap';
import { ChatRoster, Distribution, GrantUpload, OwnIdentity, PublicKey } from '../models/crypto.model';
import { CryptoApiService } from './crypto-api.service';
import {
    isRetryablePublishError,
    MemberSetMismatchError,
    RetryLimitExceededError,
    RosterVerificationError,
} from './crypto-errors';
import { MAX_SKIPPED_AGE_MS, SkippedKeyStore } from './skipped-key-store.service';

const DEVICE_ID_KEY = 'ns.device_id';

/**
 * Retry policy for publishing a sender key (TB-30): at most `maxAttempts` tries, waiting
 * `2^n * baseDelayMs` after failed attempt `n` (n from 0), so 250 ms then 500 ms by default. An
 * injection token so specs can drive time instead of sleeping.
 */
export interface PublishRetryPolicy {
    maxAttempts: number;
    baseDelayMs: number;
    sleep: (ms: number) => Promise<void>;
}

export const SENDER_KEY_PUBLISH_POLICY = new InjectionToken<PublishRetryPolicy>('SENDER_KEY_PUBLISH_POLICY', {
    providedIn: 'root',
    factory: () => ({
        maxAttempts: 3,
        baseDelayMs: 250,
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    }),
});

interface UnlockedIdentity {
    userId: string;
    deviceId: string;
    signingPrivate: Uint8Array;
    signingPublic: Uint8Array;
    identityPrivate: Uint8Array;
    // Present once this device has minted a signed prekey — which `generateIdentity` does by
    // default from registration onward. Absent for a bundle sealed before rotation was re-enabled;
    // `ingestDistributions` falls back to `identityPrivate` whenever this is missing, or when
    // unwrapping with it fails because the grant predates the prekey's existence.
    prekeyPrivate?: Uint8Array;
    // The *previous* generation's prekey private half, retained for exactly one rotation cycle —
    // see crypto-spec-v1.md §2.1.2/§2.2. `unwrapGrantForSelf` tries this after `prekeyPrivate` and
    // before `identityPrivate`, so a grant published against the outgoing prekey but not yet
    // ingested when rotation happened still opens. Absent before this device's first rotation, and
    // discarded on every rotation after that — one cycle only, not an accumulated history.
    prevPrekeyPrivate?: Uint8Array;
    // The Argon2id-derived key from this session's unlock (or from registration), kept only in
    // memory so `rotatePrekey` can re-seal the bundle without prompting for the password again —
    // see crypto-spec-v1.md §2.1.2. Same lifetime and threat model as the private key material
    // above: never persisted, gone on `lock()`.
    kek: Uint8Array;
    kdfParams: KdfParams;
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
    private readonly skippedStore = inject(SkippedKeyStore);
    private readonly publishPolicy = inject(SENDER_KEY_PUBLISH_POLICY);

    private identity: UnlockedIdentity | null = null;

    /**
     * Identifies one unlocked session. Replaced on unlock, cleared on lock. Async work compares it
     * rather than the identity object, which `rotatePrekey` legitimately replaces mid-flight.
     */
    private sessionToken: object | null = null;

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

    /**
     * Forget this browser's device id. Called after the account is deleted: the server retains the
     * deleted account's public keys under that id, so a later account created in this browser must
     * mint its own rather than collide with them.
     */
    forgetDeviceId(): void {
        localStorage.removeItem(DEVICE_ID_KEY);
    }

    get currentIdentity(): UnlockedIdentity | null {
        return this.identity;
    }

    /** Create and publish a fresh identity for this device. Called once, at registration. */
    async createAndPublishIdentity(userId: string, password: string, displayName = 'web'): Promise<void> {
        const deviceId = this.deviceId;
        // Mints a signed prekey alongside the identity keypair (see `generateIdentity`'s
        // docstring): its private half needs to be inside the sealed bundle from the very first
        // seal, or a later rotation has nowhere to put one without a fresh password prompt.
        const bundle = generateIdentity(userId, deviceId);
        const wrapped = await wrapPrivateBundle(bundle, password);

        await firstValueFrom(
            this.cryptoApi.publishIdentity({
                device_id: deviceId,
                display_name: displayName,
                identity_public_key: b64uEncode(bundle.identityPublic),
                signing_public_key: b64uEncode(bundle.signingPublic),
                identity_key_signature: b64uEncode(bundle.identityKeySignature),
                signed_prekey_public: bundle.prekeyPublic ? b64uEncode(bundle.prekeyPublic) : null,
                signed_prekey_signature: bundle.signedPrekeySignature ? b64uEncode(bundle.signedPrekeySignature) : null,
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
            prekeyPrivate: bundle.prekeyPrivate,
            kek: wrapped.kek,
            kdfParams: wrapped.kdfParams,
        };
        this.sessionToken = {};
        this.isUnlocked.set(true);
        void this.skippedStore.pruneOlderThan(Date.now() - MAX_SKIPPED_AGE_MS);
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
                prekeyPrivate: opened.prekeyPrivate,
                prevPrekeyPrivate: opened.prevPrekeyPrivate,
                kek: opened.kek,
                kdfParams: mine.kdf_params as unknown as KdfParams,
            };
            this.sessionToken = {};
            this.isUnlocked.set(true);
            void this.skippedStore.pruneOlderThan(Date.now() - MAX_SKIPPED_AGE_MS);

            return true;
        } catch {
            // A GCM tag failure here means the wrong password, not a corrupt bundle.
            return false;
        }
    }

    /**
     * Rotate this device's medium-term signed prekey.
     *
     * Safe now that every bundle carries `prekey_private` from registration onward (see
     * `generateIdentity`): re-sealing here needs only the KEK this session already derived at
     * unlock, not the password again. `sealPrivateBundle` reuses the existing Argon2id
     * salt/parameters — the password has not changed, so there is nothing to re-derive — and
     * refreshes only the AES-GCM nonce and the plaintext, which now carries the new prekey's
     * private half alongside the unchanged identity/signing privates.
     *
     * Does not touch the identity keypair, its version, or any existing grant: role and prekey
     * changes are not confidentiality boundaries (crypto-spec-v1.md §5.2), so nothing here forces a
     * chat re-key. It does mean every *future* grant to this device prefers the new prekey — see
     * `ensureSenderChain` — while grants already issued keep working, because `ingestDistributions`
     * falls back to `identityPrivate` whenever unwrapping with a prekey fails.
     *
     * The outgoing `prekeyPrivate` is carried forward as `prevPrekeyPrivate` — dropping whatever
     * `prevPrekeyPrivate` held before — so a grant published against it but not yet ingested at the
     * moment of rotation still opens for exactly one further rotation cycle (crypto-spec-v1.md
     * §2.1.2). `unwrapGrantForSelf` tries it between `prekeyPrivate` and `identityPrivate`.
     */
    async rotatePrekey(): Promise<PublicKey> {
        const identity = this.requireIdentity();

        const { prekeyPrivate, prekeyPublic, signature } = generateSignedPrekey(
            identity.signingPrivate,
            identity.userId,
            identity.deviceId
        );

        const prevPrekeyPrivate = identity.prekeyPrivate;

        const sealed = await sealPrivateBundle(
            {
                signingPrivate: identity.signingPrivate,
                identityPrivate: identity.identityPrivate,
                prekeyPrivate,
                prevPrekeyPrivate,
            },
            identity.kek,
            identity.kdfParams
        );

        const updated = await firstValueFrom(
            this.cryptoApi.rotatePrekey({
                device_id: identity.deviceId,
                signed_prekey_public: b64uEncode(prekeyPublic),
                signed_prekey_signature: b64uEncode(signature),
                encrypted_private_bundle: sealed.encryptedPrivateBundle,
                kdf_params: sealed.kdfParams as unknown as Record<string, unknown>,
            })
        );

        this.identity = { ...identity, prekeyPrivate, prevPrekeyPrivate, kdfParams: sealed.kdfParams };

        return updated;
    }

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

        // `prekeyPrivate` and `prevPrekeyPrivate` carry through when present — dropping either here
        // would silently strand a rotated prekey (or its one-cycle grace window) the moment the
        // password changes, since the server has no way to notice a re-wrap quietly lost a field
        // the blob is opaque to.
        const rewrapped = await wrapPrivateBundle(
            {
                signingPrivate: opened.signingPrivate,
                identityPrivate: opened.identityPrivate,
                prekeyPrivate: opened.prekeyPrivate,
                prevPrekeyPrivate: opened.prevPrekeyPrivate,
            },
            newPassword
        );

        // Prove it opens before it leaves this machine.
        const verified = await unwrapPrivateBundle(rewrapped.encryptedPrivateBundle, rewrapped.kdfParams, newPassword);

        if (
            b64uEncode(verified.signingPrivate) !== b64uEncode(opened.signingPrivate) ||
            b64uEncode(verified.identityPrivate) !== b64uEncode(opened.identityPrivate) ||
            b64uEncode(verified.prekeyPrivate ?? new Uint8Array()) !==
                b64uEncode(opened.prekeyPrivate ?? new Uint8Array()) ||
            b64uEncode(verified.prevPrekeyPrivate ?? new Uint8Array()) !==
                b64uEncode(opened.prevPrekeyPrivate ?? new Uint8Array())
        ) {
            throw new Error('Re-wrapped bundle did not round-trip; refusing to change the password.');
        }

        return rewrapped;
    }

    /**
     * Derive the safety number for a peer **locally**, from key material this client verifies.
     *
     * `GET /crypto/safety-number/{peer}` exists and its own docstring concedes that a malicious
     * server could simply lie about the answer — yet the UI displayed that answer verbatim, which
     * makes the whole out-of-band comparison theatre. The number has to be computed from the keys
     * the client will actually encrypt to, and each of those keys has to be checked against its
     * own binding signature first, or "the key changed" is again just something the server says.
     */
    async computeSafetyNumber(peerUserId: string): Promise<string> {
        const identity = this.requireIdentity();

        const keys = await firstValueFrom(this.cryptoApi.getKeysBatch([identity.userId, peerUserId]));

        const verified = keys.filter((key) =>
            verifyIdentityBinding(
                key.user_id,
                key.device_id,
                b64uDecode(key.identity_public_key),
                b64uDecode(key.signing_public_key),
                b64uDecode(key.identity_key_signature)
            )
        );

        const mine = verified.filter((k) => k.user_id === identity.userId).map((k) => b64uDecode(k.signing_public_key));
        const theirs = verified.filter((k) => k.user_id === peerUserId).map((k) => b64uDecode(k.signing_public_key));

        if (mine.length === 0) {
            throw new Error('You have not published an identity key.');
        }
        if (theirs.length === 0) {
            throw new Error('This contact has not published a verifiable identity key.');
        }

        return safetyNumber(userFingerprintMaterial(mine), userFingerprintMaterial(theirs));
    }

    /**
     * Drop every key and wipe persisted skipped keys. The in-memory teardown is synchronous; the
     * returned promise settles once storage has been cleared, so callers that can wait should.
     * A failed wipe is logged rather than swallowed: rows left behind are wrapped under a KEK that
     * is now gone, but the user should not be told they were erased when they were not.
     */
    lock(): Promise<void> {
        this.identity = null;
        this.sessionToken = null;
        this.ownChains.clear();
        this.peerChains.clear();
        this.chainSigningKeys.clear();
        this.isUnlocked.set(false);
        // Persisted skipped keys go with the KEK that wraps them: lock, logout, password reset and
        // account deletion all land here.
        return this.wipeSkipped();
    }

    private async wipeSkipped(): Promise<void> {
        try {
            if (!(await this.skippedStore.clear())) {
                console.error('Could not erase stored skipped keys; they remain wrapped under a discarded key.');
            }
        } catch (error) {
            console.error('Could not erase stored skipped keys.', error);
        }
    }

    /**
     * Call after the server accepted a password change. This device's bundle is now sealed under a
     * new KEK, so adopt it in memory and erase everything wrapped under the old one: leaving the old
     * rows would keep keys readable with the old password, which is exactly what changing it is for.
     * Rows written from here on use the new KEK (observers read the current one at write time).
     */
    async completePasswordChange(rewrapped: WrappedBundle): Promise<void> {
        const identity = this.requireIdentity();
        this.identity = { ...identity, kek: rewrapped.kek, kdfParams: rewrapped.kdfParams };
        await this.wipeSkipped();
    }

    private requireIdentity(): UnlockedIdentity {
        if (!this.identity) {
            throw new Error('key store is locked');
        }
        return this.identity;
    }

    /**
     * Refuse to hand out keys unless the roster proves itself. Throws on any failure.
     *
     * Two independent checks, and both are necessary:
     *
     * **The member set hash** catches a roster that disagrees with the epoch the server committed
     * to when it opened — a ghost device inserted after the fact, or a device quietly dropped. On
     * its own it proves little, because the server writes the commitment as well as the roster and
     * could simply write a consistent lie. It is the cheap consistency check, not the root of trust.
     *
     * **The binding signatures** are the root of trust. Each entry's X25519 key (and its prekey,
     * when present) must be signed by that device's Ed25519 signing key — and the signing key is
     * exactly what a peer pins out of band through the safety number. So to substitute a key the
     * server would have to substitute the signing key too, which changes the safety number and
     * becomes visible to a user who has verified their peer.
     *
     * Without this, everything above it was decorative: the client wrapped the chain key for
     * whatever public key the server put in front of it.
     */
    private verifyRoster(roster: ChatRoster): void {
        for (const member of roster.members) {
            const signingPublic = b64uDecode(member.signing_public_key);

            if (
                !verifyIdentityBinding(
                    member.user_id,
                    member.device_id,
                    b64uDecode(member.identity_public_key),
                    signingPublic,
                    b64uDecode(member.identity_key_signature)
                )
            ) {
                throw new RosterVerificationError(
                    `Roster verification failed: device ${member.device_id} presents an identity key ` +
                        'that its own signing key does not vouch for. Refusing to distribute keys.'
                );
            }

            if (member.signed_prekey_public) {
                // An unsigned prekey is rejected outright rather than silently ignored. Ignoring
                // it would fall back to the identity key and quietly succeed, which hides the
                // fact that someone tried to inject a key — and this client cannot open grants
                // wrapped to a prekey anyway, so proceeding would only produce `no_key`.
                if (
                    !member.signed_prekey_signature ||
                    !verifySignedPrekey(
                        member.user_id,
                        member.device_id,
                        b64uDecode(member.signed_prekey_public),
                        signingPublic,
                        b64uDecode(member.signed_prekey_signature)
                    )
                ) {
                    throw new RosterVerificationError(
                        `Roster verification failed: device ${member.device_id} presents a signed prekey ` +
                            'without a valid binding signature. Refusing to distribute keys.'
                    );
                }
            }
        }

        const recomputed = computeMemberSetHash(roster.members);
        if (recomputed !== roster.member_set_hash) {
            throw new MemberSetMismatchError(
                "Member set verification failed: the server's roster does not match the epoch commitment. " +
                    'Refusing to distribute keys.'
            );
        }
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
        const token = this.sessionToken;
        const { maxAttempts, baseDelayMs, sleep } = this.publishPolicy;

        let lastError: unknown;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                // A whole fresh attempt every time: the roster is re-read and re-verified (the
                // member set may be exactly why the last upload was refused), and the chain is
                // new, because a lost response may still have stored the previous sender_key_id
                // and the server would refuse a duplicate.
                return await this.publishSenderChain(identity, chatId, epoch, cacheKey);
            } catch (error) {
                // Roster refusals and every non-transient 4xx fall through here untouched.
                if (!isRetryablePublishError(error)) {
                    throw error;
                }
                lastError = error;
                if (attempt + 1 < maxAttempts) {
                    await sleep(baseDelayMs * 2 ** attempt);
                    if (this.sessionToken !== token) {
                        throw new Error('key store is locked');
                    }
                }
            }
        }

        throw new RetryLimitExceededError(maxAttempts, lastError);
    }

    private async publishSenderChain(
        identity: UnlockedIdentity,
        chatId: string,
        epoch: number,
        cacheKey: string
    ): Promise<OwnChain> {
        const roster = await firstValueFrom(this.cryptoApi.getRoster(chatId));

        this.verifyRoster(roster);

        const chainKey = generateChainKey();
        const senderKeyId = uuidv4();
        // Throwaway signing identity for this one chain — it exists only to sign the distribution
        // below, so it has no business publishing (or needing) a prekey of its own.
        const chainIdentity = generateIdentity(identity.userId, identity.deviceId, false);

        const grants: GrantUpload[] = [];
        for (const member of roster.members) {
            // Defensive: the roster never includes a deleted account, but nothing may be wrapped to
            // the retained key of one. Skipped after verification, so the commitment still covers it.
            if (member.is_active === false) {
                continue;
            }

            // Prefer the signed prekey: it gives forward secrecy for the grant once it rotates.
            // The recipient must hold the matching private half — `ingestDistributions` tries
            // `prekeyPrivate` first and falls back to `identityPrivate`, so either publishing state
            // on the recipient's side can open this.
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
        const token = this.sessionToken;

        for (const dist of distributions) {
            const cacheKey = `${chatId}:${dist.epoch}:${dist.sender_key_id}`;
            if (this.peerChains.has(cacheKey) || !dist.grant) {
                continue;
            }

            // Verify the sender's long-term key vouches for this chain before trusting it.
            const senderKeys = await firstValueFrom(this.cryptoApi.getKeysBatch([dist.sender_user_id]));
            const senderKey = senderKeys.find((k) => k.device_id === dist.sender_device_id);

            // Fail closed on a missing key, not open. This used to read `senderKey && !verify(...)`,
            // so a server that simply omitted the sender's device from the batch response skipped
            // the check entirely and got its forged distribution accepted. "We could not check"
            // must mean "we do not trust it".
            if (
                !senderKey ||
                !verifyIdentityBinding(
                    senderKey.user_id,
                    senderKey.device_id,
                    b64uDecode(senderKey.identity_public_key),
                    b64uDecode(senderKey.signing_public_key),
                    b64uDecode(senderKey.identity_key_signature)
                ) ||
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
                // A forged or unverifiable distribution: skip it rather than decrypt messages we
                // cannot attribute.
                continue;
            }

            try {
                const { chainKey, chainStartIndex } = await this.unwrapGrantForSelf(identity, chatId, dist.grant, {
                    epoch: dist.epoch,
                    senderKeyId: dist.sender_key_id,
                    senderDeviceId: dist.sender_device_id,
                });

                const chain = new ReceiverChain(chainKey, chainStartIndex);
                await this.attachSkippedPersistence(identity, token, chatId, dist.epoch, dist.sender_key_id, chain);
                if (this.sessionToken !== token) {
                    // Locked while we were reading storage: register nothing.
                    return;
                }

                this.peerChains.set(cacheKey, chain);
                this.chainSigningKeys.set(dist.sender_key_id, b64uDecode(dist.signing_public_key));
            } catch {
                // Neither private half opened it: a grant wrapped to a prekey we have since
                // rotated away from with no fallback path, or one whose ciphertext genuinely does
                // not match either key. Leaves `getReceiverChain` returning undefined, which
                // `MessageService` already surfaces as `no_key` — retryable once a fresh grant
                // arrives, not a decrypt failure.
                continue;
            }
        }
    }

    /**
     * Seed `chain.skipped` from storage and mirror later changes back to it (TB-32).
     *
     * Every failure here is swallowed on purpose: the retained set is an optimisation over what the
     * ratchet re-derives from the grant, never a precondition for opening a message. An entry that
     * fails to open - wrong KEK after a password change, tampering, or a record moved to another
     * chain/index (the AAD binds user, chat, epoch, sender key and index) - is deleted, not trusted.
     */
    private async attachSkippedPersistence(
        identity: UnlockedIdentity,
        token: object | null,
        chatId: string,
        epoch: number,
        senderKeyId: string,
        chain: ReceiverChain
    ): Promise<void> {
        const chainId = `${identity.userId}|${chatId}|${epoch}|${senderKeyId}`;
        const where = (index: number) => ({ userId: identity.userId, chatId, epoch, senderKeyId, index });

        const kekAtStart = this.identity?.kek;
        try {
            const cutoff = Date.now() - MAX_SKIPPED_AGE_MS;
            const restored = new Map<number, MessageKey>();
            for (const row of await this.skippedStore.forChain(chainId)) {
                if (row.savedAt < cutoff) {
                    void this.skippedStore.delete(row.id);
                    continue;
                }
                try {
                    if (row.id !== `${chainId}|${row.index}`) {
                        throw new Error('record id does not match its location');
                    }
                    restored.set(row.index, await unwrapSkippedKey(kekAtStart as Uint8Array, where(row.index), row));
                } catch {
                    void this.skippedStore.delete(row.id);
                }
            }
            if (this.sessionToken !== token || this.identity?.kek !== kekAtStart) {
                return;
            }
            chain.restoreSkipped(restored);
        } catch {
            // Fall through to live mirroring with whatever we have.
        }

        if (this.sessionToken !== token) {
            return;
        }

        chain.skippedObserver = {
            retained: (index, key) => {
                // The KEK current at write time, so a password change is picked up; a row wrapped
                // under a KEK that was replaced while we waited is dropped, never written.
                const kek = this.identity?.kek;
                if (!kek || this.sessionToken !== token) {
                    return;
                }
                wrapSkippedKey(kek, where(index), key)
                    .then((wrapped) => {
                        // The key may have been consumed, or the store locked, while wrapping.
                        if (this.sessionToken !== token || this.identity?.kek !== kek || !chain.skipped.has(index)) {
                            return;
                        }
                        return this.skippedStore.put({
                            id: `${chainId}|${index}`,
                            chain: chainId,
                            index,
                            savedAt: Date.now(),
                            ...wrapped,
                        });
                    })
                    .catch(() => undefined);
            },
            consumed: (index) => {
                void this.skippedStore.delete(`${chainId}|${index}`);
            },
        };
    }

    /**
     * Unwrap one grant addressed to this device.
     *
     * `ensureSenderChain` wraps to `signed_prekey_public ?? identity_public_key` (whatever the
     * roster showed the sender at send time), so this device must be willing to try either private
     * half. Prefer the prekey — that is the common case once a device has published one — then
     * `prevPrekeyPrivate` if this device has rotated: that covers a grant published against the
     * *outgoing* prekey but not yet ingested when rotation happened (crypto-spec-v1.md §2.1.2), for
     * exactly one further rotation cycle. Fall back to the identity key last: a bundle with no
     * `prekeyPrivate` (this device predates rotation) has nothing else to try, and even a device
     * that does have one may be opening a grant that was wrapped before its prekey existed, back
     * when the sender still saw only the identity key.
     */
    private async unwrapGrantForSelf(
        identity: UnlockedIdentity,
        chatId: string,
        grant: NonNullable<Distribution['grant']>,
        params: { epoch: number; senderKeyId: string; senderDeviceId: string }
    ): Promise<{ chainKey: Uint8Array; chainStartIndex: number }> {
        const base = {
            wrapped: grant.wrapped_chain_key,
            ephemeralPublic: grant.ephemeral_public_key,
            chatId,
            epoch: params.epoch,
            senderKeyId: params.senderKeyId,
            senderDeviceId: params.senderDeviceId,
            recipientDeviceId: identity.deviceId,
        };

        if (identity.prekeyPrivate) {
            try {
                return await unwrapChainKey({ ...base, recipientPrivate: identity.prekeyPrivate });
            } catch {
                // Falls through to the grace-window / identity-key attempts below — this grant may
                // predate our current prekey.
            }
        }

        if (identity.prevPrekeyPrivate) {
            try {
                return await unwrapChainKey({ ...base, recipientPrivate: identity.prevPrekeyPrivate });
            } catch {
                // Falls through to the identity-key attempt below — this grant may predate even the
                // previous prekey generation.
            }
        }

        return await unwrapChainKey({ ...base, recipientPrivate: identity.identityPrivate });
    }

    getReceiverChain(chatId: string, epoch: number, senderKeyId: string): ReceiverChain | undefined {
        return this.peerChains.get(`${chatId}:${epoch}:${senderKeyId}`);
    }

    getChainSigningKey(senderKeyId: string): Uint8Array | undefined {
        return this.chainSigningKeys.get(senderKeyId);
    }
}
