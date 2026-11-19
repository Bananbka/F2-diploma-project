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
    derivePublicKeys,
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
import { ChatRoster, Distribution, GrantUpload, OwnIdentity, PublicKey, RosterEntry } from '../models/crypto.model';
import { CryptoApiService } from './crypto-api.service';
import {
    IdentityMismatchError,
    isRetryablePublishError,
    KeyChangedError,
    KeyChangedPeer,
    MemberSetMismatchError,
    MembershipMismatchError,
    MembershipUnconfirmedError,
    RetryLimitExceededError,
    RosterVerificationError,
    TrustChangedDuringPublishError,
    UnknownOwnDeviceError,
} from './crypto-errors';
import { KeyChangeStateService, ObservationSource } from './key-change-state.service';
import { MAX_SKIPPED_AGE_MS, SkippedKeyStore } from './skipped-key-store.service';
import { TrustStoreService } from './trust-store.service';

const DEVICE_ID_KEY = 'ns.device_id';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function ownDevicesMissing(): MembershipMismatchError {
    return new MembershipMismatchError(
        'Member verification failed: the roster does not include your own devices. Refusing to distribute keys.'
    );
}

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
    /**
     * `TrustStoreService.revision` when the roster this chain was wrapped to was checked. A chain
     * stamped with an older revision is never reused: it was checked against confirmed numbers the
     * user has since changed (e.g. wrapped to a ghost device while that peer was unverified).
     */
    trustRevision: number;
}

/** A published key as the roster, the batch lookup and `GET /crypto/identity/me` all carry it. */
interface KeyRow {
    user_id: string;
    device_id: string;
    identity_public_key: string;
    signing_public_key: string;
    identity_key_signature: string;
    is_active?: boolean;
}

/** A safety number as `computeSafetyNumber` derives it, with what it found about our own side. */
export interface SafetyNumberResult {
    number: string;
    /**
     * Our side covers a device that neither our device list at unlock nor a fresh one contains.
     * Matching digits would then confirm that device too.
     */
    ownDevicesUnknown: boolean;
    /**
     * Our side covers a device not in our device list at unlock, and a fresh list could not be
     * fetched to say whether it is ours. Not the same claim as `ownDevicesUnknown` — nothing is known
     * to be wrong — but the screen must still warn rather than imply the device was checked.
     */
    ownDevicesUnchecked: boolean;
    /** Our side covers a device our account gained since unlock (listed by our device list now). */
    ownDevicesAdded: boolean;
}

/**
 * Who may legitimately appear in a chat's roster, as this client knows it — independently of the
 * roster itself. `verifyRoster` proves the roster is self-consistent; it says nothing about whether
 * a user id in it belongs in the chat at all, and an unverified third user is exactly where a server
 * can plant a device that nobody's safety number covers.
 *
 * - `private` — exactly the two people the user opened the chat with. Pinned at registration (and
 *   persisted by `MembershipGuardService`): a private chat's counterpart
 *   never changes, so a later, different answer — including the same chat reported as a group — is
 *   refused, never adopted.
 * - `group` — the chat's participant list, re-read from the server for every publish so a member
 *   who joined since the chat was opened is not treated as an intruder. The resolver is expected to
 *   publish what it read to the UI before returning, so the member list shows exactly the set that
 *   was checked.
 */
export type MemberExpectation =
    { kind: 'private'; selfId: string; peerId: string } | { kind: 'group'; resolve: () => Promise<readonly string[]> };

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
    private readonly trust = inject(TrustStoreService);
    private readonly keyChange = inject(KeyChangeStateService);

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
    /** (chatId, epoch, senderKeyId) -> the chain's Ed25519 public key, for verifying message signatures */
    private readonly chainSigningKeys = new Map<string, Uint8Array>();
    /**
     * (chatId, epoch, senderKeyId) -> the user who owns that chain, as proven at distribution ingest (their identity
     * key vouched for it). A message's claimed `sender_id` must equal this: the envelope AAD binds
     * the sender id, but whoever holds a chain can seal a message claiming to be someone else.
     */
    private readonly chainOwners = new Map<string, string>();

    /**
     * (chatId, epoch, senderKeyId) -> owner, for chains vouched for by a device that is in no safety
     * number: the retained device of an account presented as deleted. See `ingestDistributions`.
     */
    private readonly uncoveredChains = new Map<string, string>();

    /** chatId -> who may appear in its roster; see `MemberExpectation`. */
    private readonly memberExpectations = new Map<string, MemberExpectation>();

    /**
     * deviceId -> signing key (b64u) of this account's active devices as `GET /crypto/identity/me`
     * listed them at unlock, minus any revoked since (`noteOwnDeviceRevoked`). A roster key under
     * our id outside this set *and* outside a fresh device list is refused outright
     * (`UnknownOwnDeviceError`); one outside this set only is attributed to our side when a verified
     * peer's number changes.
     */
    private ownDevicesAtUnlock = new Map<string, string>();

    /**
     * A device was added to our account since unlock: seen under our id in a roster or a lookup,
     * absent from the unlock-time list, present in a fresh device list. Not blocking — the user may
     * well have just signed in elsewhere — but worth a notice pointing at Settings → Devices.
     * Raised only here; lowered by `acknowledgeOwnDevicesAdded` (or `lock`).
     */
    private readonly ownDevicesAddedState = signal(false);
    readonly ownDevicesAdded = this.ownDevicesAddedState.asReadonly();

    /** Signing keys behind the current `ownDevicesAdded` notice. */
    private readonly addedOwnKeys = new Set<string>();

    /**
     * Added devices the user has acknowledged (looked at the device list, or dismissed the notice).
     * Seeing one of these again does not raise the notice again; a device not among them does.
     */
    private readonly acknowledgedOwnKeys = new Set<string>();

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
        this.ownDevicesAtUnlock = new Map([[deviceId, b64uEncode(bundle.signingPublic)]]);
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
     *
     * Returns false for a wrong password. Throws `IdentityMismatchError` when the password opened
     * the bundle but the keys inside are not the ones published for `userId` - nothing is unlocked
     * in that case.
     */
    async unlock(userId: string, password: string, onStage?: UnlockStageReporter): Promise<boolean> {
        await onStage?.('fetching');
        const identities = await firstValueFrom(this.cryptoApi.getOwnIdentities());
        const mine = identities.find((i) => i.device_id === this.deviceId) ?? identities[0];

        if (!mine) {
            return false;
        }

        let opened: Awaited<ReturnType<typeof unwrapPrivateBundle>>;
        try {
            await onStage?.('deriving');
            opened = await unwrapPrivateBundle(mine.encrypted_private_bundle, mine.kdf_params as never, password);
        } catch {
            // A GCM tag failure here means the wrong password, not a corrupt bundle.
            return false;
        }
        await onStage?.('opening');

        // The bundle opening proves the password and nothing else. `userId` came from `/auth/me`
        // and the public halves from `/crypto/identity/me`, so both are the server's word until
        // checked against the private keys we just opened. Every local trust record (confirmed
        // safety numbers, pinned private chats, refusals, the encrypted-chat set) is keyed by our
        // own id: a server that answered with a different id would otherwise make all of them read
        // as absent, with no alarm at all. The binding signature was made by our signing key over
        // our user id and device id (crypto-spec-v1.md section 2.1), so it verifies under the key
        // derived from the opened private half only for the id the keys were registered under.
        const { signingPublic, identityPublic } = derivePublicKeys(opened.signingPrivate, opened.identityPrivate);
        if (!this.ownRowMatchesBundle(userId, mine, signingPublic, identityPublic)) {
            throw new IdentityMismatchError();
        }

        this.identity = {
            userId,
            deviceId: mine.device_id,
            signingPrivate: opened.signingPrivate,
            // Derived, not the server's copy: what we sign with is what we call our public key.
            signingPublic,
            identityPrivate: opened.identityPrivate,
            prekeyPrivate: opened.prekeyPrivate,
            prevPrekeyPrivate: opened.prevPrekeyPrivate,
            kek: opened.kek,
            kdfParams: mine.kdf_params as unknown as KdfParams,
        };
        this.ownDevicesAtUnlock = new Map(
            identities
                .filter((i) => i.user_id === userId && i.is_active !== false)
                .map((i) => [i.device_id, b64uEncode(b64uDecode(i.signing_public_key))])
        );
        this.sessionToken = {};
        this.isUnlocked.set(true);
        void this.skippedStore.pruneOlderThan(Date.now() - MAX_SKIPPED_AGE_MS);

        return true;
    }

    /**
     * True when the published row the bundle came with is ours under `userId`: same user id, public
     * keys equal to the ones the opened private halves derive, and a binding signature over exactly
     * (`userId`, device id, identity key) that verifies under the derived signing key. Any malformed
     * field reads as a mismatch.
     */
    private ownRowMatchesBundle(
        userId: string,
        mine: OwnIdentity,
        signingPublic: Uint8Array,
        identityPublic: Uint8Array
    ): boolean {
        try {
            return (
                mine.user_id === userId &&
                bytesEqual(b64uDecode(mine.signing_public_key), signingPublic) &&
                bytesEqual(b64uDecode(mine.identity_public_key), identityPublic) &&
                verifyIdentityBinding(
                    userId,
                    mine.device_id,
                    identityPublic,
                    signingPublic,
                    b64uDecode(mine.identity_key_signature)
                )
            );
        } catch {
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
    async computeSafetyNumber(peerUserId: string): Promise<SafetyNumberResult> {
        const identity = this.requireIdentity();

        const keys = await firstValueFrom(this.cryptoApi.getKeysBatch([identity.userId, peerUserId]));
        const verified = this.bindingVerifiedActive(keys);

        const mine = verified.filter((k) => k.user_id === identity.userId).map((k) => b64uDecode(k.signing_public_key));
        const theirs = verified.filter((k) => k.user_id === peerUserId).map((k) => b64uDecode(k.signing_public_key));

        if (mine.length === 0) {
            throw new Error('You have not published an identity key.');
        }
        if (theirs.length === 0) {
            throw new Error('This contact has not published a verifiable identity key.');
        }

        const number = this.safetyNumberFor(mine, theirs);
        // A lookup, not the roster: it may raise an alarm but cannot clear one the send path raised.
        this.keyChange.observe(identity.userId, peerUserId, number, 'lookup');

        // Our own side of this number may include a device neither our device list at unlock nor a
        // fresh one knows. It is part of the digits being compared, so the screen must say so: two
        // people can match a number that covers a device neither of them controls.
        const extra = this.extraOwnKeys(identity, verified);
        let ownDevicesUnknown = false;
        let ownDevicesUnchecked = false;
        try {
            ownDevicesUnknown = (await this.unknownOwnKeys(identity, extra)).length > 0;
        } catch {
            // Could not re-check our own device list. Not evidence of anything — but the screen
            // still warns, rather than implying the extra device was confirmed as ours.
            ownDevicesUnchecked = true;
        }
        const ownDevicesAdded = extra.length > 0 && !ownDevicesUnknown && !ownDevicesUnchecked;
        if (ownDevicesAdded) {
            this.noteOwnDevicesAdded(extra);
        }
        return { number, ownDevicesUnknown, ownDevicesUnchecked, ownDevicesAdded };
    }

    /**
     * The user has seen the devices behind the `ownDevicesAdded` notice — the device list was shown,
     * or the notice dismissed. Lowers it; those devices do not raise it again this session.
     */
    acknowledgeOwnDevicesAdded(): void {
        this.addedOwnKeys.forEach((key) => this.acknowledgedOwnKeys.add(key));
        this.addedOwnKeys.clear();
        this.ownDevicesAddedState.set(false);
    }

    /** Raise the `ownDevicesAdded` notice for any of these confirmed-ours keys not yet acknowledged. */
    private noteOwnDevicesAdded(extra: readonly string[]): void {
        const fresh = extra.filter((key) => !this.acknowledgedOwnKeys.has(key));
        if (fresh.length > 0) {
            fresh.forEach((key) => this.addedOwnKeys.add(key));
            this.ownDevicesAddedState.set(true);
        }
    }

    /**
     * Signing keys under our own id in `keys` that are not among our devices as known at unlock.
     *
     * Also what attributes a verified peer's changed number to *our* side: a device under our id
     * changes the number with every verified peer at once, and blaming each peer would mislead.
     * Extra keys only: a device revoked this session is merely absent, which changes the number but
     * is our own doing.
     *
     * TODO(G6): attribute precisely by storing our own fingerprint material in each trust record at
     * verification time; then a change can be pinned to whichever side's material moved, without
     * relying on any server-supplied device list.
     */
    private extraOwnKeys(identity: UnlockedIdentity, keys: readonly KeyRow[]): string[] {
        const known = new Set(this.ownDevicesAtUnlock.values());
        return [...this.activeSigningKeys(keys, identity.userId)].filter((key) => !known.has(key));
    }

    /**
     * Those of `extra` (from `extraOwnKeys`) that a fresh `GET /crypto/identity/me` does not contain
     * either. Only *extra* keys count: a device revoked this session is simply absent from a roster,
     * which is not suspicious. The fresh list is fetched only when there is an extra key to explain;
     * a transient failure of that fetch propagates (the publish retry policy handles it) rather than
     * being read as an alarm.
     */
    private async unknownOwnKeys(identity: UnlockedIdentity, extra: readonly string[]): Promise<string[]> {
        if (extra.length === 0) {
            return [];
        }
        const fresh = this.activeSigningKeys(await firstValueFrom(this.cryptoApi.getOwnIdentities()), identity.userId);
        return extra.filter((key) => !fresh.has(key));
    }

    /**
     * A device of ours was revoked this session. It leaves the unlock-time list, so a roster that
     * still carries it later is no longer explained by "it was ours at unlock".
     */
    noteOwnDeviceRevoked(deviceId: string): void {
        this.ownDevicesAtUnlock.delete(deviceId);
    }

    /**
     * Signing keys of `userId`'s devices among `keys` that pass `bindingVerifiedActive`, re-encoded so
     * encodings compare equal.
     */
    private activeSigningKeys(keys: readonly KeyRow[], userId: string): Set<string> {
        return new Set(
            this.bindingVerifiedActive(keys.filter((key) => key.user_id === userId)).map((key) =>
                b64uEncode(b64uDecode(key.signing_public_key))
            )
        );
    }

    /**
     * The only keys anything here fingerprints or compares: active, and with an identity key that
     * their own signing key vouches for. One filter for every caller (safety number, roster check,
     * ingest, own-device comparison), so they can never disagree about which devices count.
     *
     * Inactive keys are a deleted account's retained devices, kept only so old messages stay
     * verifiable. Nothing is wrapped to them, so they are no part of any number: counting them made
     * every deleted user's revoked device read as a key change. Unvouched keys are what a server
     * could substitute freely; fingerprinting one would make "the key changed" its say-so again.
     */
    private bindingVerifiedActive<T extends KeyRow>(keys: readonly T[]): T[] {
        return this.bindingVerified(keys.filter((key) => key.is_active !== false));
    }

    /** Keys whose identity key their own signing key vouches for, active or not. */
    private bindingVerified<T extends KeyRow>(keys: readonly T[]): T[] {
        return keys.filter((key) =>
            verifyIdentityBinding(
                key.user_id,
                key.device_id,
                b64uDecode(key.identity_public_key),
                b64uDecode(key.signing_public_key),
                b64uDecode(key.identity_key_signature)
            )
        );
    }

    /**
     * The one place a safety number is assembled from signing keys (crypto-spec-v1.md §2.3). The
     * roster check in `publishSenderChain`, the ingest check in `ingestDistributions` and the
     * safety-number screen all go through here, so the number the user compares out of band is
     * byte-for-byte the number those checks compare it against.
     */
    private safetyNumberFor(mine: Uint8Array[], theirs: Uint8Array[]): string {
        return safetyNumber(userFingerprintMaterial(mine), userFingerprintMaterial(theirs));
    }

    /**
     * Derive each peer's safety number, and report the peers whose number no longer matches what the
     * user confirmed. Named for its side effects, which are the point: it *records* every number it
     * derives as an observation, and settles this chat's refusals (clearing one whose roster now
     * derives the confirmed number).
     *
     * Only keys passing `bindingVerifiedActive` are fingerprinted, whatever the caller passes — the
     * batch lookup in particular may carry a key the server could not vouch for. Grouped by user because a safety
     * number is a property of a person: every one of their devices contributes (§2.3), so a device
     * the server planted shows up as a change even if the original keys are still listed. Our own
     * side is taken from the same key set, and only from it.
     *
     * Returns null when the set carries no active key of ours. There used to be a fallback to this
     * device's signing key alone, but a number built from it can never equal the one the
     * safety-number screen shows (which covers all our devices), so it compared nothing — callers
     * decide what an absent self means instead (the roster path refuses outright).
     *
     * Same filter as `computeSafetyNumber`, so both derive the same number from the same devices.
     * Callers re-read the confirmed records (`TrustStoreService.refresh`) first — once per batch of
     * calls, not per call: another tab may have verified someone a moment ago.
     */
    private recordNumbersAndFindChanges(
        identity: UnlockedIdentity,
        keys: readonly KeyRow[],
        source: ObservationSource,
        chatId?: string
    ): KeyChangedPeer[] | null {
        const byUser = new Map<string, Uint8Array[]>();
        for (const key of this.bindingVerifiedActive(keys)) {
            const list = byUser.get(key.user_id) ?? [];
            list.push(b64uDecode(key.signing_public_key));
            byUser.set(key.user_id, list);
        }

        const mine = byUser.get(identity.userId);
        if (!mine) {
            return null;
        }
        const changed: KeyChangedPeer[] = [];

        for (const [userId, theirs] of byUser) {
            if (userId === identity.userId) {
                continue;
            }
            const current = this.safetyNumberFor(mine, theirs);
            const state = this.trust.stateFor(identity.userId, userId, current);
            // A refusal outstanding in this chat holds until the user confirms a number: clearing
            // the verification must not turn the refused keys into trust-on-first-use.
            const refusal = chatId ? this.keyChange.refusalFor(chatId, identity.userId, userId) : null;
            if (state.kind === 'changed') {
                changed.push({ userId, current, previous: state.previous });
            } else if (refusal && state.kind !== 'verified') {
                changed.push({ userId, current, previous: refusal.previous });
            } else if (chatId && state.kind === 'verified') {
                // This chat's roster now derives the confirmed number: its refusal is over.
                this.keyChange.clearRefusal(chatId, identity.userId, userId);
            }
            // Observed after the refusal is settled, so a roster that cleared its own refusal can
            // also replace the refused observation (which an outstanding refusal would protect).
            this.keyChange.observe(identity.userId, userId, current, source);
        }

        return changed;
    }

    /**
     * Refuse a roster that names anyone the chat is not known to contain, or that leaves us out.
     *
     * Every other roster check is about keys. This one is about people: a device the server mints
     * under a *third* user id with a valid self-binding passes `verifyRoster`, and leaves every
     * verified number unchanged — nobody has a safety number with a user they never expected to
     * be there. Inactive entries are skipped (nothing is wrapped to them).
     */
    private async verifyRosterMembership(
        identity: UnlockedIdentity,
        roster: ChatRoster,
        expectation: MemberExpectation
    ): Promise<RosterEntry | null> {
        let allowed: Set<string>;
        if (expectation.kind === 'private') {
            if (expectation.selfId !== identity.userId || expectation.peerId === identity.userId) {
                throw new MembershipMismatchError(
                    'Member verification failed: this private chat was not opened by the unlocked account. ' +
                        'Refusing to distribute keys.'
                );
            }
            allowed = new Set([identity.userId, expectation.peerId]);
        } else {
            // Residual: the participant list is server-asserted, like the roster. This stops a
            // device under a user id the chat does not even claim to have; it cannot stop a server
            // that adds a member to both answers consistently. What it does guarantee is that such a
            // member is not hidden: `MembershipGuardService`'s resolver writes the list it returns into
            // the chat state the member list and header render from, before anything is wrapped.
            allowed = new Set([identity.userId, ...(await expectation.resolve())]);
        }

        const active = roster.members.filter((member) => member.is_active !== false);
        if (!active.some((member) => member.user_id === identity.userId)) {
            throw ownDevicesMissing();
        }
        return active.find((member) => !allowed.has(member.user_id)) ?? null;
    }

    private outsiderError(outsider: RosterEntry): MembershipMismatchError {
        return new MembershipMismatchError(
            `Member verification failed: device ${outsider.device_id} belongs to a user who is not a member of ` +
                'this chat. Refusing to distribute keys.'
        );
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
        this.chainOwners.clear();
        this.uncoveredChains.clear();
        this.memberExpectations.clear();
        this.ownDevicesAtUnlock = new Map();
        this.ownDevicesAddedState.set(false);
        this.addedOwnKeys.clear();
        this.acknowledgedOwnKeys.clear();
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
        // Pick up a verification made in another tab before deciding whether the cache is current.
        this.trust.refresh();
        const existing = this.ownChains.get(cacheKey);
        if (existing && existing.trustRevision === this.trust.revision()) {
            return existing;
        }
        if (existing) {
            // What the user has confirmed changed since this chain's roster was checked. The chain
            // may already be wrapped to a device the user would now refuse, so no further message
            // goes out on it: republish, which re-reads and re-verifies the roster.
            this.invalidateOwnChains();
        }

        const identity = this.requireIdentity();
        const expectation = this.memberExpectations.get(chatId);
        if (!expectation) {
            // Fail closed, but not as a roster alarm: nothing is known to be wrong, the chat's
            // membership simply has not been confirmed. Surfaces as a retryable failed send with its
            // own wording.
            throw new MembershipUnconfirmedError();
        }
        const token = this.sessionToken;
        const { maxAttempts, baseDelayMs, sleep } = this.publishPolicy;

        let lastError: unknown;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                // A whole fresh attempt every time: the roster is re-read and re-verified (the
                // member set may be exactly why the last upload was refused), and the chain is
                // new, because a lost response may still have stored the previous sender_key_id
                // and the server would refuse a duplicate.
                return await this.publishSenderChain(identity, chatId, epoch, cacheKey, expectation);
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
        cacheKey: string,
        expectation: MemberExpectation
    ): Promise<OwnChain> {
        let roster = await firstValueFrom(this.cryptoApi.getRoster(chatId));

        this.verifyRoster(roster);
        let outsider = await this.verifyRosterMembership(identity, roster, expectation);
        if (outsider && expectation.kind === 'group') {
            // The roster is read before the participant list, so a member removed in between looks
            // like an outsider for one round trip. Re-read both once before raising the alarm.
            roster = await firstValueFrom(this.cryptoApi.getRoster(chatId));
            this.verifyRoster(roster);
            outsider = await this.verifyRosterMembership(identity, roster, expectation);
        }
        if (outsider) {
            throw this.outsiderError(outsider);
        }

        // A device under our own id reads everything we send, in every chat, and no unverified
        // peer's number would ever reveal it — so this is checked regardless of verification state.
        const extraOwn = this.extraOwnKeys(identity, roster.members);
        const unknownOwn = await this.unknownOwnKeys(identity, extraOwn);
        if (unknownOwn.length === 0 && extraOwn.length > 0) {
            // A device our account gained since unlock, confirmed by our own device list: allowed,
            // but surfaced as a notice (`ownDevicesAdded`).
            this.noteOwnDevicesAdded(extraOwn);
        }
        if (unknownOwn.length > 0) {
            throw new UnknownOwnDeviceError(
                'Member verification failed: this chat lists a device under your account that your own device ' +
                    'list does not contain. Refusing to distribute keys.'
            );
        }

        // §5.0.2 proves the roster is self-consistent; this is what makes that proof bite. A server
        // can mint a whole device — valid self-binding, recomputed commitment — and it passes both
        // checks above. What it cannot do is reproduce the safety number the user already compared
        // with that person. So for every peer the user has verified, the number the roster's keys
        // derive to must still be the one on record, or nothing is wrapped. Peers never verified
        // (trust on first use) are unaffected, as are peers whose number still matches.
        //
        // The records are re-read first and the revision taken with them, then stamped on the chain:
        // any later change to what the user confirmed retires the chain (and one that lands while
        // this chain is being wrapped and published is caught before it is returned, below).
        this.trust.refresh();
        const trustRevision = this.trust.revision();
        const changed = this.recordNumbersAndFindChanges(identity, roster.members, 'roster', chatId);
        if (changed === null) {
            // `verifyRosterMembership` already refused a roster without us; kept as a type guard.
            throw ownDevicesMissing();
        }
        if (changed.length > 0) {
            // Remembered per chat, so another chat's honest roster for the same person cannot erase
            // what this one was refused on (see `KeyChangeStateService.refusals`).
            // Attributed to our side when the roster carries a device of ours added since unlock
            // (`extraOwnKeys`): it changes the number with every verified peer at once.
            const ownDevicesChanged = extraOwn.length > 0;
            for (const peer of changed) {
                this.keyChange.recordRefusal(
                    chatId,
                    identity.userId,
                    peer.userId,
                    peer.current,
                    peer.previous,
                    ownDevicesChanged
                );
            }
            throw new KeyChangedError(chatId, changed, ownDevicesChanged);
        }

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

        // The wrap and the upload above are awaited, and a verification (here or in another tab)
        // can land during either. The roster was checked against the confirmations as they were
        // before it, so this chain must not seal the message in flight: drop it uncached and let the
        // retry loop in `ensureSenderChain` publish afresh against a re-read, re-checked roster.
        this.trust.refresh();
        if (this.trust.revision() !== trustRevision) {
            throw new TrustChangedDuringPublishError();
        }

        const own: OwnChain = {
            senderKeyId,
            chain: new SenderChain(chainKey),
            chainSigningPrivate: chainIdentity.signingPrivate,
            trustRevision,
        };

        this.ownChains.set(cacheKey, own);
        this.registerChain(chatId, epoch, senderKeyId, identity.userId, chainIdentity.signingPublic);
        return own;
    }

    /**
     * Re-run this chat's roster check now, rather than on the next send — the way out of a block
     * that no send can reach (the composer is disabled while it holds). Drops the cached chain for
     * the epoch and publishes a fresh one, which re-reads and re-verifies the roster: on success the
     * refusal is cleared and the observation updated; otherwise the same refusal is thrown again.
     * Publishing a chain nobody has sent on yet is harmless; the server keeps several per epoch.
     */
    async recheckRoster(chatId: string, epoch: number): Promise<void> {
        this.invalidateSenderChain(chatId, epoch);
        await this.ensureSenderChain(chatId, epoch);
    }

    /** Drop a cached sending chain, forcing a fresh one on next send (used after EPOCH_STALE). */
    invalidateSenderChain(chatId: string, epoch: number): void {
        this.ownChains.delete(`${chatId}:${epoch}`);
    }

    /**
     * Drop every cached sending chain, so the next send in any chat republishes and re-verifies its
     * roster. `ensureSenderChain` already does this by itself whenever `TrustStoreService.revision`
     * moved past a chain's stamp — which is how a verification, an accepted change or a cleared
     * verification (here or in another tab) reaches this service without the trust store depending
     * on it. Exposed for callers that know a re-check is due for any other reason.
     *
     * All chains rather than those whose roster held the affected peer: a verification is rare, a
     * republish is one request per chat on its next send, and the narrower version would have to
     * remember every roster to be sure it missed none.
     */
    invalidateOwnChains(): void {
        this.ownChains.clear();
    }

    /**
     * Register who may appear in this chat's roster; see `MemberExpectation`.
     *
     * A private expectation is never replaced by anything else for the same account — not by a
     * different counterpart, and not by a group expectation (a server re-labelling an A-B chat as a
     * group with a third member must not get that member a key). A conflicting registration throws
     * `MembershipMismatchError`; `ChatStoreService` checks its persisted pin first and raises the
     * same alarm, so this is the second line, not the first.
     */
    expectMembers(chatId: string, expectation: MemberExpectation): void {
        const existing = this.memberExpectations.get(chatId);
        if (existing?.kind === 'private' && existing.selfId === this.identity?.userId) {
            if (
                expectation.kind === 'private' &&
                expectation.selfId === existing.selfId &&
                expectation.peerId === existing.peerId
            ) {
                return;
            }
            throw new MembershipMismatchError(
                'Member verification failed: this private chat is now reported with different members. ' +
                    'Refusing to distribute keys.'
            );
        }
        this.memberExpectations.set(chatId, expectation);
    }

    /** Unwrap every grant addressed to us and build the matching receiver chains. */
    async ingestDistributions(chatId: string, distributions: Distribution[]): Promise<void> {
        const identity = this.requireIdentity();
        const token = this.sessionToken;
        // Once for the whole batch rather than per distribution: each refresh re-reads and re-parses
        // the stored records, and a verification made mid-batch is caught by the next send anyway.
        this.trust.refresh();

        for (const dist of distributions) {
            const cacheKey = `${chatId}:${dist.epoch}:${dist.sender_key_id}`;
            if (this.peerChains.has(cacheKey) || !dist.grant) {
                continue;
            }

            // First registration wins. A slot already bound to a different owner or signing key is
            // not overwritten: the later distribution is rejected for that slot.
            if (
                !this.chainSlotAccepts(
                    chatId,
                    dist.epoch,
                    dist.sender_key_id,
                    dist.sender_user_id,
                    dist.signing_public_key
                )
            ) {
                continue;
            }

            // Verify the sender's long-term key vouches for this chain before trusting it. Our own
            // keys ride along in the same request (one round trip, not two) so the sender's safety
            // number can be derived below exactly as the safety-number screen derives it.
            const batchIds =
                dist.sender_user_id === identity.userId ? [identity.userId] : [identity.userId, dist.sender_user_id];
            const batchKeys = await firstValueFrom(this.cryptoApi.getKeysBatch(batchIds));
            const fromSelf = dist.sender_user_id === identity.userId;
            const isSender = (k: KeyRow) => k.user_id === dist.sender_user_id && k.device_id === dist.sender_device_id;

            // The sender's device is resolved through `bindingVerifiedActive` - the very filter the
            // safety number is built from - so a device that vouches for a chain is, by
            // construction, one the number covers. Looking it up in the raw batch let a server
            // attach a self-bound device marked inactive: it passed the binding check, signed a
            // distribution, and stayed out of every fingerprint, so a verified peer's number never
            // moved while the server's chain was accepted as theirs.
            let senderKey: KeyRow | undefined = this.bindingVerifiedActive(batchKeys).find(isSender);
            const covered = senderKey !== undefined;

            // The one exception: an account presented as deleted. The server keeps a deleted
            // account's keys, flagged inactive, precisely so its old messages stay verifiable, and
            // refusing them would turn every departed member's history into `no_key` on each reload.
            // It is allowed only where it cannot weaken a promise: the sender is someone else, has
            // no active device in this answer at all (so one inactive device cannot ride beside the
            // real ones), and the user holds no confirmed number for them. Such a chain is recorded
            // as uncovered, and `getReceiverChain` stops handing it out the moment a confirmation
            // for that peer exists.
            if (!senderKey && !fromSelf && !this.hasTrustRecord(identity, dist.sender_user_id)) {
                const theirs = batchKeys.filter((k) => k.user_id === dist.sender_user_id);
                if (theirs.every((k) => k.is_active === false)) {
                    senderKey = this.bindingVerified(theirs).find(isSender);
                }
            }

            // Fail closed on a missing key, not open. This used to read `senderKey && !verify(...)`,
            // so a server that simply omitted the sender's device from the batch response skipped
            // the check entirely and got its forged distribution accepted. "We could not check"
            // must mean "we do not trust it".
            if (
                !senderKey ||
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

            // The receive-side half of the check `publishSenderChain` makes before wrapping. A
            // changed key is *noted* here, never acted on: the distribution is still ingested, so
            // the user can read what the (possibly substituted) sender wrote and judge it against
            // the alarm, while the trust store's observation blocks sending through `ChatStoreService`
            // until the new number is confirmed. Only binding-verified, active keys are fingerprinted —
            // the batch may carry one the server could not vouch for, or a deleted account's
            // retained device, which `computeSafetyNumber` leaves out too. A `lookup` observation:
            // it comes from the batch endpoint, so it cannot clear a change the roster showed.
            //
            // When the batch carries no key of ours no number can be derived at all (null). For a
            // peer with a confirmed number that is not "nothing to note" - it is the comparison
            // being withheld, and a server could withhold it on purpose by leaving our keys out of
            // the answer. The distribution is then skipped (the messages stay `no_key` and are
            // retried), never accepted unchecked. Without a confirmation there is nothing to
            // compare against, so the outcome is the same either way.
            if (!fromSelf && covered) {
                const changes = this.recordNumbersAndFindChanges(identity, batchKeys, 'lookup');
                if (changes === null && this.hasTrustRecord(identity, dist.sender_user_id)) {
                    continue;
                }
            }
            // A confirmation may have been made in another tab while the batch was in flight.
            if (!covered && this.hasTrustRecord(identity, dist.sender_user_id)) {
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
                if (!covered) {
                    this.uncoveredChains.set(cacheKey, dist.sender_user_id);
                }
                // `senderKey` was fetched for exactly `dist.sender_user_id` and passed the identity
                // binding check above, so this owner is the one the sender's own key vouches for.
                this.registerChain(
                    chatId,
                    dist.epoch,
                    dist.sender_key_id,
                    dist.sender_user_id,
                    b64uDecode(dist.signing_public_key)
                );
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
        const slot = `${chatId}:${epoch}:${senderKeyId}`;
        // A chain vouched for by a device no safety number covers is not used for a peer the user
        // has since confirmed a number for: that confirmation never covered this chain.
        const uncoveredOwner = this.uncoveredChains.get(slot);
        if (uncoveredOwner !== undefined && this.identity && this.hasTrustRecord(this.identity, uncoveredOwner)) {
            return undefined;
        }
        return this.peerChains.get(slot);
    }

    /** True when the user holds a confirmed safety number for `peerId` (matching or changed). */
    private hasTrustRecord(identity: UnlockedIdentity, peerId: string): boolean {
        return this.trust.recordStamp(identity.userId, peerId) !== null;
    }

    getChainSigningKey(chatId: string, epoch: number, senderKeyId: string): Uint8Array | undefined {
        return this.chainSigningKeys.get(`${chatId}:${epoch}:${senderKeyId}`);
    }

    /** The user a sender chain belongs to, or undefined for a chain we have not ingested. */
    getChainOwner(chatId: string, epoch: number, senderKeyId: string): string | undefined {
        return this.chainOwners.get(`${chatId}:${epoch}:${senderKeyId}`);
    }

    /**
     * Bind a chain slot to its owner and signing key, once. Keyed by chat and epoch as well as the
     * sender key id, so the same id presented in another chat or epoch (or by another sender) can
     * neither overwrite nor be confused with the genuine entry.
     */
    private registerChain(
        chatId: string,
        epoch: number,
        senderKeyId: string,
        ownerId: string,
        signingPublic: Uint8Array
    ): void {
        const slot = `${chatId}:${epoch}:${senderKeyId}`;
        if (this.chainOwners.has(slot)) {
            return;
        }
        this.chainOwners.set(slot, ownerId);
        this.chainSigningKeys.set(slot, signingPublic);
    }

    /** True when the slot is free, or already bound to exactly this owner and signing key. */
    private chainSlotAccepts(
        chatId: string,
        epoch: number,
        senderKeyId: string,
        ownerId: string,
        signingPublicB64: string
    ): boolean {
        const slot = `${chatId}:${epoch}:${senderKeyId}`;
        const owner = this.chainOwners.get(slot);
        if (owner === undefined) {
            return true;
        }
        const key = this.chainSigningKeys.get(slot);
        const offered = b64uDecode(signingPublicB64);
        return (
            owner === ownerId &&
            key !== undefined &&
            key.length === offered.length &&
            key.every((byte, index) => byte === offered[index])
        );
    }
}
