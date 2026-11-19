import { HttpErrorResponse } from '@angular/common/http';
import { Injector } from '@angular/core';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { argon2id } from '@noble/hashes/argon2.js';
import { of, throwError } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

import { sealMessage } from '../crypto/envelope';
import { computeMemberSetHash, signDistribution, wrapChainKey } from '../crypto/grants';
import {
    generateIdentity,
    IdentityBundle,
    KdfParams,
    safetyNumber,
    sealPrivateBundle,
    userFingerprintMaterial,
} from '../crypto/identity';
import { b64uDecode, b64uEncode, utf8 } from '../crypto/primitives';
import { generateChainKey, SenderChain } from '../crypto/ratchet';
import {
    ChatRoster,
    Distribution,
    OwnIdentity,
    PrekeyRotateRequest,
    PublicKey,
    RosterEntry,
} from '../models/crypto.model';
import { ChatApiService } from './chat-api.service';
import { CryptoApiService } from './crypto-api.service';
import {
    KeyChangedError,
    MemberSetMismatchError,
    MembershipMismatchError,
    MembershipUnconfirmedError,
    RetryLimitExceededError,
    RosterVerificationError,
    UnknownOwnDeviceError,
} from './crypto-errors';
import { KeyChangeStateService } from './key-change-state.service';
import { KeyStoreService, SENDER_KEY_PUBLISH_POLICY } from './key-store.service';
import { MessageService } from './message.service';
import { SKIPPED_KEY_DB_NAME, SKIPPED_KEY_IDB, SkippedKeyStore } from './skipped-key-store.service';
import { TrustStoreService } from './trust-store.service';

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEVICE = 'b0000000-0000-4000-8000-000000000002';
const CHAT = 'c0000000-0000-4000-8000-000000000003';
const SENDER_USER = 'd0000000-0000-4000-8000-000000000004';
const SENDER_DEVICE = 'e0000000-0000-4000-8000-000000000005';
const PASSWORD = 'correct horse battery staple';

/** A `PublicKey` row matching a bundle just generated in a test, as `getKeysBatch` would return it. */
function publicKeyFor(userId: string, deviceId: string, bundle: IdentityBundle): PublicKey {
    return {
        user_id: userId,
        device_id: deviceId,
        identity_key_id: uuidv4(),
        version: 1,
        identity_public_key: b64uEncode(bundle.identityPublic),
        signing_public_key: b64uEncode(bundle.signingPublic),
        identity_key_signature: b64uEncode(bundle.identityKeySignature),
        signed_prekey_public: bundle.prekeyPublic ? b64uEncode(bundle.prekeyPublic) : null,
        signed_prekey_signature: bundle.signedPrekeySignature ? b64uEncode(bundle.signedPrekeySignature) : null,
    };
}

/** A signed, grant-carrying distribution a real sender would publish via `ensureSenderChain`. */
async function buildDistribution(params: {
    epoch: number;
    senderIdentity: IdentityBundle;
    recipientPublic: Uint8Array;
    recipientDeviceId: string;
    /** Reuse a sender key id, to model the same id turning up in another slot. */
    senderKeyId?: string;
    /** Receives the chain secrets, for tests that must seal messages on this chain. */
    capture?: { chainKey?: Uint8Array; chainSigningPrivate?: Uint8Array };
}): Promise<Distribution> {
    const senderKeyId = params.senderKeyId ?? uuidv4();
    // Throwaway chain-signing keypair, exactly as `ensureSenderChain` mints one per chain.
    const chainIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE, false);
    const chainKey = generateChainKey();
    if (params.capture) {
        params.capture.chainKey = chainKey;
        params.capture.chainSigningPrivate = chainIdentity.signingPrivate;
    }

    const wrapped = await wrapChainKey({
        chainKey,
        chainStartIndex: 0,
        recipientPublic: params.recipientPublic,
        chatId: CHAT,
        epoch: params.epoch,
        senderKeyId,
        senderDeviceId: SENDER_DEVICE,
        recipientDeviceId: params.recipientDeviceId,
    });

    return {
        distribution_id: uuidv4(),
        epoch: params.epoch,
        sender_user_id: SENDER_USER,
        sender_device_id: SENDER_DEVICE,
        sender_key_id: senderKeyId,
        algorithm: 'hkdf_sha256_aes256gcm_v1',
        signing_public_key: b64uEncode(chainIdentity.signingPublic),
        chain_start_index: 0,
        signature: signDistribution({
            identitySigningPrivate: params.senderIdentity.signingPrivate,
            chatId: CHAT,
            epoch: params.epoch,
            senderKeyId,
            chainSigningPublic: chainIdentity.signingPublic,
            chainStartIndex: 0,
        }),
        grant: {
            recipient_device_id: params.recipientDeviceId,
            recipient_identity_key_id: uuidv4(),
            wrap_algorithm: 'x25519_hkdf_sha256_aes256gcm_v1',
            ephemeral_public_key: wrapped.ephemeralPublicKey,
            wrapped_chain_key: wrapped.wrappedChainKey,
        },
    };
}

/** Wait for a fire-and-forget write (or delete) to land. */
async function until(condition: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error('condition not reached in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** Seals a bundle under {@link PASSWORD} with test-only Argon2id parameters (8 KiB, 1 pass, 1 lane). */
async function sealCheaply(bundle: IdentityBundle): ReturnType<typeof sealPrivateBundle> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kdfParams: KdfParams = {
        kdf: 'argon2id',
        m: 8,
        t: 1,
        p: 1,
        salt: b64uEncode(salt),
        nonce: '',
    };
    const kek = argon2id(new TextEncoder().encode(PASSWORD), salt, { t: 1, m: 8, p: 1, dkLen: 32 });
    return sealPrivateBundle(bundle, kek, kdfParams);
}

describe('KeyStoreService', () => {
    // The bundles below are sealed with deliberately tiny Argon2id parameters. `unwrapPrivateBundle`
    // derives from whatever parameters the bundle carries, so this exercises the same unlock path while
    // keeping each unlock to milliseconds. At the production 64 MiB x 3 passes, each unlock blocks the
    // main thread for ~2.7 s, which on a slow CI runner starves Karma's socket ping and disconnects it.
    // The production parameters are covered by the crypto specs and `npm run interop`.
    const defaultTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    beforeAll(() => (jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000));
    afterAll(() => (jasmine.DEFAULT_TIMEOUT_INTERVAL = defaultTimeout));

    let service: KeyStoreService;
    let cryptoApi: jasmine.SpyObj<CryptoApiService>;
    let sleep: jasmine.Spy<(ms: number) => Promise<void>>;
    let dbName: string;
    const sealedBundles = new Map<
        boolean,
        { bundle: IdentityBundle; wrapped?: Awaited<ReturnType<typeof sealPrivateBundle>> }
    >();

    beforeEach(() => {
        localStorage.clear();

        cryptoApi = jasmine.createSpyObj<CryptoApiService>('CryptoApiService', [
            'getOwnIdentities',
            'publishIdentity',
            'rotatePrekey',
            'getKeysBatch',
            'getRoster',
            'publishSenderKey',
        ]);

        sleep = jasmine.createSpy('sleep').and.resolveTo();
        dbName = `test-skipped-${uuidv4()}`;

        TestBed.configureTestingModule({
            providers: [
                KeyStoreService,
                { provide: CryptoApiService, useValue: cryptoApi },
                // Only reached by the integration specs, which build a real MessageService.
                { provide: ChatApiService, useValue: {} },
                { provide: SKIPPED_KEY_DB_NAME, useValue: dbName },
                { provide: SENDER_KEY_PUBLISH_POLICY, useValue: { maxAttempts: 3, baseDelayMs: 250, sleep } },
            ],
        });
        service = TestBed.inject(KeyStoreService);
    });

    afterEach(() => localStorage.clear());

    /** Unlocks the service against a freshly-sealed bundle this test fully controls. */
    async function unlockWithBundle(withPrekey: boolean, otherOwnDevices: OwnIdentity[] = []): Promise<IdentityBundle> {
        localStorage.setItem('ns.device_id', DEVICE);

        // Sealing costs a full Argon2id run; the bundle is immutable, so seal each shape once.
        const cached = sealedBundles.get(withPrekey) ?? {
            bundle: generateIdentity(USER, DEVICE, withPrekey),
            wrapped: undefined as Awaited<ReturnType<typeof sealPrivateBundle>> | undefined,
        };
        cached.wrapped ??= await sealCheaply(cached.bundle);
        sealedBundles.set(withPrekey, cached);
        const { bundle, wrapped } = cached as { bundle: IdentityBundle; wrapped: NonNullable<typeof cached.wrapped> };

        const own: OwnIdentity = {
            ...publicKeyFor(USER, DEVICE, bundle),
            encrypted_private_bundle: wrapped.encryptedPrivateBundle,
            kdf_params: wrapped.kdfParams as unknown as OwnIdentity['kdf_params'],
            created_at: new Date().toISOString(),
            signed_prekey_created_at: null,
            display_name: 'test device',
        };
        cryptoApi.getOwnIdentities.and.returnValue(of([own, ...otherOwnDevices]));

        const ok = await service.unlock(USER, PASSWORD);
        expect(ok).toBeTrue();

        return bundle;
    }

    describe('ingestDistributions', () => {
        /** The bug this whole feature exists to fix: a grant wrapped to the signed prekey must be
         *  openable with the matching private half, not just the identity key. */
        it('unwraps a grant wrapped to the signed prekey when the bundle has one', async () => {
            const bundle = await unlockWithBundle(true);
            const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));

            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity,
                recipientPublic: bundle.prekeyPublic!,
                recipientDeviceId: DEVICE,
            });

            await service.ingestDistributions(CHAT, [dist]);

            expect(service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)).toBeDefined();
        });

        it('binds an ingested chain to the user whose identity vouched for it', async () => {
            const bundle = await unlockWithBundle(true);
            const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));
            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity,
                recipientPublic: bundle.prekeyPublic!,
                recipientDeviceId: DEVICE,
            });

            expect(service.getChainOwner(CHAT, dist.epoch, dist.sender_key_id)).toBeUndefined();
            await service.ingestDistributions(CHAT, [dist]);

            expect(service.getChainOwner(CHAT, dist.epoch, dist.sender_key_id)).toBe(SENDER_USER);
        });

        describe('chain slots are (chat, epoch, sender key id)', () => {
            it('keeps the same sender key id in another epoch apart from the genuine entry', async () => {
                const bundle = await unlockWithBundle(true);
                const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
                cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));
                const base = { senderIdentity, recipientPublic: bundle.prekeyPublic!, recipientDeviceId: DEVICE };

                const genuine = await buildDistribution({ ...base, epoch: 1 });
                const reused = await buildDistribution({ ...base, epoch: 2, senderKeyId: genuine.sender_key_id });
                await service.ingestDistributions(CHAT, [genuine, reused]);

                const key1 = service.getChainSigningKey(CHAT, 1, genuine.sender_key_id)!;
                const key2 = service.getChainSigningKey(CHAT, 2, genuine.sender_key_id)!;
                expect(b64uEncode(key1)).toBe(genuine.signing_public_key);
                expect(b64uEncode(key2)).toBe(reused.signing_public_key);
                expect(b64uEncode(key1)).not.toBe(b64uEncode(key2));
                expect(service.getReceiverChain(CHAT, 1, genuine.sender_key_id)).toBeDefined();
            });

            it('knows nothing of a sender key id in a chat it was never registered for', async () => {
                const bundle = await unlockWithBundle(true);
                const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
                cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));
                const dist = await buildDistribution({
                    epoch: 1,
                    senderIdentity,
                    recipientPublic: bundle.prekeyPublic!,
                    recipientDeviceId: DEVICE,
                });
                await service.ingestDistributions(CHAT, [dist]);

                expect(service.getChainOwner('other-chat', 1, dist.sender_key_id)).toBeUndefined();
                expect(service.getChainSigningKey('other-chat', 1, dist.sender_key_id)).toBeUndefined();
                expect(service.getChainOwner(CHAT, 2, dist.sender_key_id)).toBeUndefined();
            });

            /** The first registration of a slot is final, whoever it belongs to (own chain included). */
            it('ignores a foreign distribution for a slot already bound to another owner', async () => {
                const bundle = await unlockWithBundle(true);
                const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
                cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));
                const dist = await buildDistribution({
                    epoch: 1,
                    senderIdentity,
                    recipientPublic: bundle.prekeyPublic!,
                    recipientDeviceId: DEVICE,
                });

                // Our own chain (or an earlier genuine one) already holds this slot.
                const ownKey = crypto.getRandomValues(new Uint8Array(32));
                (
                    service as unknown as {
                        registerChain: (c: string, e: number, k: string, owner: string, key: Uint8Array) => void;
                    }
                ).registerChain(CHAT, 1, dist.sender_key_id, USER, ownKey);

                await service.ingestDistributions(CHAT, [dist]);

                expect(service.getChainOwner(CHAT, 1, dist.sender_key_id)).toBe(USER);
                expect(service.getChainSigningKey(CHAT, 1, dist.sender_key_id)).toEqual(ownKey);
                expect(service.getReceiverChain(CHAT, 1, dist.sender_key_id)).toBeUndefined();
            });

            it('does not let a conflicting re-registration replace the first', async () => {
                const bundle = await unlockWithBundle(true);
                const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
                cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));
                const base = { senderIdentity, recipientPublic: bundle.prekeyPublic!, recipientDeviceId: DEVICE };
                const genuine = await buildDistribution({ ...base, epoch: 1 });
                const conflicting = await buildDistribution({ ...base, epoch: 1, senderKeyId: genuine.sender_key_id });

                await service.ingestDistributions(CHAT, [genuine]);
                await service.ingestDistributions(CHAT, [conflicting]);

                expect(b64uEncode(service.getChainSigningKey(CHAT, 1, genuine.sender_key_id)!)).toBe(
                    genuine.signing_public_key
                );
            });
        });

        describe('with the real MessageService (no stubbed owner lookup)', () => {
            const VICTIM = 'f0000000-0000-4000-8000-0000000000aa';

            async function setup(): Promise<{
                messages: MessageService;
                dist: Distribution;
                seal: (
                    claimedSender: string,
                    text: string
                ) => Promise<import('../models/crypto.model').MessageResponse>;
            }> {
                const bundle = await unlockWithBundle(true);
                const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
                cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));
                const capture: { chainKey?: Uint8Array; chainSigningPrivate?: Uint8Array } = {};
                const dist = await buildDistribution({
                    epoch: 1,
                    senderIdentity,
                    recipientPublic: bundle.prekeyPublic!,
                    recipientDeviceId: DEVICE,
                    capture,
                });
                await service.ingestDistributions(CHAT, [dist]);

                // Every message is a fresh chain at index 0, so each is openable on its own.
                const seal = async (claimedSender: string, text: string) => {
                    const { key, nonce, index } = new SenderChain(capture.chainKey!).nextMessageKey();
                    const envelope = await sealMessage({
                        messageKey: key,
                        nonce,
                        signingPrivate: capture.chainSigningPrivate!,
                        chatId: CHAT,
                        epoch: 1,
                        senderId: claimedSender,
                        senderKeyId: dist.sender_key_id,
                        chainIndex: index,
                        plaintext: utf8(JSON.stringify({ text, attachmentKeys: [] })),
                    });
                    return {
                        _id: uuidv4().replace(/-/g, '').slice(0, 24),
                        chat_id: CHAT,
                        sender_id: claimedSender,
                        encrypted_content: null,
                        envelope,
                        channel_post: null,
                        content_format: 'sender_keys_v1',
                        reply_to_message_id: null,
                        forwarded_from: null,
                        created_at: '2026-01-01T00:00:00Z',
                        attachments: null,
                        reactions: [],
                        is_pinned: false,
                        pinned_at: null,
                        pinned_by: null,
                        is_edited: false,
                        is_encrypted: true,
                    } as import('../models/crypto.model').MessageResponse;
                };

                return { messages: TestBed.inject(MessageService), dist, seal };
            }

            it('refuses a message that names another member as sender, and still opens the genuine one', async () => {
                const { messages, seal } = await setup();

                // The chain's real owner seals a message that claims to come from someone else. The
                // signature verifies against their own chain key, so only the owner binding stops it.
                const forged = await messages.decrypt(CHAT, await seal(VICTIM, 'send money to me'));
                expect(forged.status).toBe('failed');
                expect(forged.text).toBeNull();
                expect(forged.senderVerified).toBeFalse();

                // Refused before the ratchet moved, so the owner's real message at the same index opens.
                const genuine = await messages.decrypt(CHAT, await seal(SENDER_USER, 'hello'));
                expect(genuine.status).toBe('ok');
                expect(genuine.text).toBe('hello');
                expect(genuine.senderVerified).toBeTrue();
            });
        });

        /** Backward compat: a bundle with no `prekeyPrivate` at all has only the identity key to try. */
        it('falls back to the identity key when the bundle has no prekey', async () => {
            const bundle = await unlockWithBundle(false);
            expect(bundle.prekeyPrivate).toBeUndefined();

            const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));

            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity,
                recipientPublic: bundle.identityPublic,
                recipientDeviceId: DEVICE,
            });

            await service.ingestDistributions(CHAT, [dist]);

            expect(service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)).toBeDefined();
        });

        /** A device that now has a prekey must still open a grant issued before it existed, when the
         *  sender's roster snapshot at wrap time only showed the identity key. */
        it("falls back to the identity key when a grant predates this device's prekey", async () => {
            const bundle = await unlockWithBundle(true);
            const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));

            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity,
                recipientPublic: bundle.identityPublic, // wrapped to the identity key, not the prekey
                recipientDeviceId: DEVICE,
            });

            await service.ingestDistributions(CHAT, [dist]);

            expect(service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)).toBeDefined();
        });

        /** A grant that opens under neither private half must be dropped, not thrown past the caller
         *  — `MessageService` treats a missing receiver chain as retryable `no_key`, not a failure. */
        it('does not create a chain when a grant matches neither private half', async () => {
            await unlockWithBundle(true);
            const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
            const strangerIdentity = generateIdentity('f0000000-0000-4000-8000-000000000006', SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));

            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity,
                recipientPublic: strangerIdentity.identityPublic, // wrapped for someone else entirely
                recipientDeviceId: DEVICE,
            });

            await service.ingestDistributions(CHAT, [dist]);

            expect(service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)).toBeUndefined();
        });
    });

    describe('rotatePrekey', () => {
        /** The entire point of carrying `prekey_private` in the bundle from registration onward:
         *  rotation must not need the password again, only the KEK already held from unlock. */
        it('rotates without re-deriving from a password, and the new key can open a grant immediately', async () => {
            await unlockWithBundle(true);

            cryptoApi.rotatePrekey.and.returnValue(
                of({
                    user_id: USER,
                    device_id: DEVICE,
                    identity_key_id: uuidv4(),
                    version: 1,
                    identity_public_key: '',
                    signing_public_key: '',
                    identity_key_signature: '',
                    signed_prekey_public: null,
                    signed_prekey_signature: null,
                } as PublicKey)
            );

            await service.rotatePrekey();

            expect(cryptoApi.rotatePrekey).toHaveBeenCalledTimes(1);
            const request = cryptoApi.rotatePrekey.calls.mostRecent().args[0] as PrekeyRotateRequest;
            expect(request.device_id).toBe(DEVICE);

            const newPrekeyPublic = b64uDecode(request.signed_prekey_public);
            const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));

            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity,
                recipientPublic: newPrekeyPublic,
                recipientDeviceId: DEVICE,
            });

            await service.ingestDistributions(CHAT, [dist]);

            expect(service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)).toBeDefined();
        });

        /** Rotation re-seals the *entire* bundle, so the identity key must still open a grant wrapped
         *  to it afterwards — rotating the prekey must never orphan the identity-key path. */
        it('keeps the identity key working for grants wrapped to it after rotating', async () => {
            const bundle = await unlockWithBundle(true);

            cryptoApi.rotatePrekey.and.returnValue(
                of({
                    user_id: USER,
                    device_id: DEVICE,
                    identity_key_id: uuidv4(),
                    version: 1,
                    identity_public_key: '',
                    signing_public_key: '',
                    identity_key_signature: '',
                    signed_prekey_public: null,
                    signed_prekey_signature: null,
                } as PublicKey)
            );

            await service.rotatePrekey();

            const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));

            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity,
                recipientPublic: bundle.identityPublic,
                recipientDeviceId: DEVICE,
            });

            await service.ingestDistributions(CHAT, [dist]);

            expect(service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)).toBeDefined();
        });

        it('throws when the store is locked', async () => {
            await expectAsync(service.rotatePrekey()).toBeRejected();
        });

        /** The bug this task exists to fix: a grant wrapped to the *outgoing* prekey, published but
         *  not yet ingested before rotation happens, must still open — via the one-cycle
         *  `prevPrekeyPrivate` grace window (crypto-spec-v1.md §2.1.2), not via anything unbounded. */
        it('opens a grant wrapped to the outgoing prekey via the one-cycle grace window after rotating', async () => {
            const bundle = await unlockWithBundle(true);
            const oldPrekeyPublic = bundle.prekeyPublic!;

            cryptoApi.rotatePrekey.and.returnValue(of(rotateResponse()));
            await service.rotatePrekey();

            const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));

            // Wrapped to the prekey that was current *before* the rotation above.
            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity,
                recipientPublic: oldPrekeyPublic,
                recipientDeviceId: DEVICE,
            });

            await service.ingestDistributions(CHAT, [dist]);

            expect(service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)).toBeDefined();
        });

        /** The grace window is exactly one cycle, not a history: a grant wrapped to the *original*
         *  (pre-first-rotation) prekey must fail gracefully — dropped as an unopenable grant, the
         *  same `no_key`-style handling as any other mismatched grant — once a *second* rotation has
         *  superseded it. */
        it('no longer opens a grant wrapped to the prekey from two rotations ago', async () => {
            const bundle = await unlockWithBundle(true);
            const originalPrekeyPublic = bundle.prekeyPublic!;

            cryptoApi.rotatePrekey.and.returnValue(of(rotateResponse()));
            await service.rotatePrekey(); // originalPrekeyPublic's private half becomes prevPrekeyPrivate
            await service.rotatePrekey(); // ...and is discarded here, superseded by the first rotation's key

            const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));

            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity,
                recipientPublic: originalPrekeyPublic,
                recipientDeviceId: DEVICE,
            });

            await expectAsync(service.ingestDistributions(CHAT, [dist])).toBeResolved();
            expect(service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)).toBeUndefined();
        });
    });

    describe('ensureSenderChain publish policy (TB-30)', () => {
        function rosterFor(bundle: IdentityBundle, overrides: Partial<ChatRoster> = {}): ChatRoster {
            const member: RosterEntry = {
                user_id: USER,
                device_id: DEVICE,
                identity_key_id: uuidv4(),
                identity_public_key: b64uEncode(bundle.identityPublic),
                signing_public_key: b64uEncode(bundle.signingPublic),
                identity_key_signature: b64uEncode(bundle.identityKeySignature),
                signed_prekey_public: bundle.prekeyPublic ? b64uEncode(bundle.prekeyPublic) : null,
                signed_prekey_signature: bundle.signedPrekeySignature ? b64uEncode(bundle.signedPrekeySignature) : null,
            };
            return {
                chat_id: CHAT,
                current_epoch: 1,
                member_set_hash: computeMemberSetHash([member]),
                members: [member],
                ...overrides,
            };
        }

        const http = (status: number, code?: string) =>
            new HttpErrorResponse({ status, error: code ? { error_code: code } : null });

        beforeEach(() => service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER }));

        it('publishes on the first try without sleeping', async () => {
            const bundle = await unlockWithBundle(true);
            cryptoApi.getRoster.and.returnValue(of(rosterFor(bundle)));
            cryptoApi.publishSenderKey.and.returnValue(of({}));

            await service.ensureSenderChain(CHAT, 1);

            expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        for (const failure of [
            ['a network error', () => http(0)],
            ['a 503', () => http(503)],
            ['EPOCH_CLOSED', () => http(409, 'EPOCH_CLOSED')],
            ['GRANT_SET_MISMATCH', () => http(400, 'GRANT_SET_MISMATCH')],
        ] as const) {
            it(`retries after ${failure[0]}, re-reading the roster and minting a fresh chain`, async () => {
                const bundle = await unlockWithBundle(true);
                cryptoApi.getRoster.and.callFake(() => of(rosterFor(bundle)));
                cryptoApi.publishSenderKey.and.returnValues(throwError(failure[1]), of({}));

                await service.ensureSenderChain(CHAT, 1);

                expect(cryptoApi.getRoster).toHaveBeenCalledTimes(2);
                expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(2);
                const ids = cryptoApi.publishSenderKey.calls.allArgs().map((args) => args[2].sender_key_id);
                expect(ids[0]).not.toBe(ids[1]);
                expect(sleep.calls.allArgs()).toEqual([[250]]);
            });
        }

        it('backs off 250 ms then 500 ms and gives up after three attempts with RETRY_LIMIT_EXCEEDED', async () => {
            const bundle = await unlockWithBundle(true);
            cryptoApi.getRoster.and.callFake(() => of(rosterFor(bundle)));
            cryptoApi.publishSenderKey.and.callFake(() => throwError(() => http(503)));

            const failure = await service.ensureSenderChain(CHAT, 1).then(
                () => null,
                (error: unknown) => error
            );

            expect(failure).toBeInstanceOf(RetryLimitExceededError);
            expect((failure as RetryLimitExceededError).code).toBe('RETRY_LIMIT_EXCEEDED');
            expect((failure as RetryLimitExceededError).attempts).toBe(3);
            expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(3);
            // No wait after the final failure: nothing is left to wait for.
            expect(sleep.calls.allArgs()).toEqual([[250], [500]]);
        });

        it('does not retry a 4xx that will not change', async () => {
            const bundle = await unlockWithBundle(true);
            cryptoApi.getRoster.and.returnValue(of(rosterFor(bundle)));
            cryptoApi.publishSenderKey.and.callFake(() => throwError(() => http(403, 'ACCESS_DENIED')));

            await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejected();

            expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        it('never retries a member-set mismatch, and sends nothing', async () => {
            const bundle = await unlockWithBundle(true);
            cryptoApi.getRoster.and.returnValue(of(rosterFor(bundle, { member_set_hash: 'f'.repeat(64) })));

            const failure = await service.ensureSenderChain(CHAT, 1).then(
                () => null,
                (error: unknown) => error
            );

            expect(failure).toBeInstanceOf(MemberSetMismatchError);
            expect((failure as MemberSetMismatchError).code).toBe('MEMBER_SET_MISMATCH');
            expect(cryptoApi.getRoster).toHaveBeenCalledTimes(1);
            expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
        });

        it('never retries a bad binding signature', async () => {
            const bundle = await unlockWithBundle(true);
            const roster = rosterFor(bundle);
            const other = generateIdentity(USER, DEVICE);
            roster.members[0].identity_public_key = b64uEncode(other.identityPublic);
            roster.member_set_hash = computeMemberSetHash(roster.members);
            cryptoApi.getRoster.and.returnValue(of(roster));

            const failure = await service.ensureSenderChain(CHAT, 1).then(
                () => null,
                (error: unknown) => error
            );

            expect(failure).toBeInstanceOf(RosterVerificationError);
            expect(failure).not.toBeInstanceOf(MemberSetMismatchError);
            expect((failure as RosterVerificationError).code).toBe('ROSTER_VERIFICATION_FAILED');
            expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
        });

        it('stops retrying if the store is locked while waiting', async () => {
            const bundle = await unlockWithBundle(true);
            cryptoApi.getRoster.and.callFake(() => of(rosterFor(bundle)));
            cryptoApi.publishSenderKey.and.callFake(() => throwError(() => http(503)));
            sleep.and.callFake(() => {
                service.lock();
                return Promise.resolve();
            });

            await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError('key store is locked');
            expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
        });
    });

    /**
     * The gap §5.0.2 leaves open: a roster whose every entry is self-consistent and whose hash
     * matches the commitment is exactly what a server replacing a peer's device produces. The only
     * thing it cannot forge is the safety number the user already compared with that person.
     */
    describe('key change of a verified peer', () => {
        let trust: TrustStoreService;

        /** The number the safety-number screen would show for `peer`, derived the same way. */
        const numberFor = (mine: IdentityBundle, peer: IdentityBundle) =>
            safetyNumber(userFingerprintMaterial([mine.signingPublic]), userFingerprintMaterial([peer.signingPublic]));

        function entryFor(userId: string, deviceId: string, bundle: IdentityBundle): RosterEntry {
            return {
                user_id: userId,
                device_id: deviceId,
                identity_key_id: uuidv4(),
                identity_public_key: b64uEncode(bundle.identityPublic),
                signing_public_key: b64uEncode(bundle.signingPublic),
                identity_key_signature: b64uEncode(bundle.identityKeySignature),
                signed_prekey_public: bundle.prekeyPublic ? b64uEncode(bundle.prekeyPublic) : null,
                signed_prekey_signature: bundle.signedPrekeySignature ? b64uEncode(bundle.signedPrekeySignature) : null,
            };
        }

        /** A roster of us plus one peer device: self-consistent, with the hash the server would store. */
        function rosterWith(mine: IdentityBundle, peer: IdentityBundle): ChatRoster {
            const members = [entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, peer)];
            return { chat_id: CHAT, current_epoch: 1, member_set_hash: computeMemberSetHash(members), members };
        }

        beforeEach(() => {
            trust = TestBed.inject(TrustStoreService);
            cryptoApi.publishSenderKey.and.returnValue(of({}));
            service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
        });

        it('wraps for a verified peer whose key is unchanged', async () => {
            const mine = await unlockWithBundle(true);
            const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
            trust.markVerified(USER, SENDER_USER, numberFor(mine, peer));
            cryptoApi.getRoster.and.returnValue(of(rosterWith(mine, peer)));

            await service.ensureSenderChain(CHAT, 1);

            expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
            const grants = cryptoApi.publishSenderKey.calls.mostRecent().args[2].grants;
            expect(grants.map((g) => g.recipient_device_id)).toContain(SENDER_DEVICE);
            expect(TestBed.inject(KeyChangeStateService).observedState(USER, SENDER_USER)?.kind).toBe('verified');
        });

        it('refuses to wrap for a verified peer whose key changed, and publishes nothing', async () => {
            const mine = await unlockWithBundle(true);
            const original = generateIdentity(SENDER_USER, SENDER_DEVICE);
            trust.markVerified(USER, SENDER_USER, numberFor(mine, original));

            // The server now presents a device it minted itself: valid self-binding, recomputed hash.
            const planted = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getRoster.and.returnValue(of(rosterWith(mine, planted)));

            const failure = await service.ensureSenderChain(CHAT, 1).then(
                () => null,
                (error: unknown) => error
            );

            expect(failure).toBeInstanceOf(KeyChangedError);
            expect(failure).not.toBeInstanceOf(RosterVerificationError);
            const changed = failure as KeyChangedError;
            expect(changed.code).toBe('KEY_CHANGED');
            expect(changed.chatId).toBe(CHAT);
            expect(changed.peers.map((p) => p.userId)).toEqual([SENDER_USER]);
            expect(changed.peers[0].previous).toBe(numberFor(mine, original));
            expect(changed.peers[0].current).toBe(numberFor(mine, planted));
            expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
            // Not a transient failure: no retry, no second roster read.
            expect(cryptoApi.getRoster).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
            expect(TestBed.inject(KeyChangeStateService).observedState(USER, SENDER_USER)?.kind).toBe('changed');
        });

        it('keeps blocking while the trust store still says changed, and wraps once the new number is confirmed', async () => {
            const mine = await unlockWithBundle(true);
            const original = generateIdentity(SENDER_USER, SENDER_DEVICE);
            const planted = generateIdentity(SENDER_USER, SENDER_DEVICE);
            trust.markVerified(USER, SENDER_USER, numberFor(mine, original));
            cryptoApi.getRoster.and.returnValue(of(rosterWith(mine, planted)));

            await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(KeyChangedError);
            await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(KeyChangedError);
            expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();

            // The user compared the new number out of band and accepted it in the safety-number screen.
            trust.markVerified(USER, SENDER_USER, numberFor(mine, planted));

            await service.ensureSenderChain(CHAT, 1);
            expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
        });

        it('wraps for a peer the user never verified, whatever key they present', async () => {
            const mine = await unlockWithBundle(true);
            const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getRoster.and.returnValue(of(rosterWith(mine, peer)));

            await service.ensureSenderChain(CHAT, 1);

            expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
            // Trust on first use: the number is noted so the safety-number screen and the chat header
            // can read it, but nothing is claimed about it.
            expect(TestBed.inject(KeyChangeStateService).observedState(USER, SENDER_USER)?.kind).toBe('unverified');
        });

        /**
         * On receive the distribution is still ingested — the user should be able to read what the
         * possibly-substituted sender wrote — but the change is recorded so sending blocks.
         */
        it('records a changed key when ingesting a distribution, without dropping the grant', async () => {
            const mine = await unlockWithBundle(true);
            const original = generateIdentity(SENDER_USER, SENDER_DEVICE);
            trust.markVerified(USER, SENDER_USER, numberFor(mine, original));

            const planted = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(
                of([publicKeyFor(USER, DEVICE, mine), publicKeyFor(SENDER_USER, SENDER_DEVICE, planted)])
            );
            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity: planted,
                recipientPublic: mine.prekeyPublic!,
                recipientDeviceId: DEVICE,
            });

            await service.ingestDistributions(CHAT, [dist]);

            expect(cryptoApi.getKeysBatch).toHaveBeenCalledWith([USER, SENDER_USER]);
            expect(service.getReceiverChain(CHAT, 1, dist.sender_key_id)).toBeDefined();
            const state = TestBed.inject(KeyChangeStateService).observedState(USER, SENDER_USER);
            expect(state?.kind).toBe('changed');
            expect(state?.kind === 'changed' && state.previous).toBe(numberFor(mine, original));
        });

        it('observes an unchanged key on ingest as still verified', async () => {
            const mine = await unlockWithBundle(true);
            const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
            trust.markVerified(USER, SENDER_USER, numberFor(mine, peer));
            cryptoApi.getKeysBatch.and.returnValue(
                of([publicKeyFor(USER, DEVICE, mine), publicKeyFor(SENDER_USER, SENDER_DEVICE, peer)])
            );
            const dist = await buildDistribution({
                epoch: 1,
                senderIdentity: peer,
                recipientPublic: mine.prekeyPublic!,
                recipientDeviceId: DEVICE,
            });

            await service.ingestDistributions(CHAT, [dist]);

            expect(service.getReceiverChain(CHAT, 1, dist.sender_key_id)).toBeDefined();
            expect(TestBed.inject(KeyChangeStateService).observedState(USER, SENDER_USER)?.kind).toBe('verified');
        });
    });

    /**
     * Follow-ups to the key-change check from the security review (G1-G7). Each block names the gap
     * it closes; together they make "a verified peer's number is unchanged" actually imply "nobody
     * else can read what we wrap".
     */
    describe('roster membership and trust follow-ups', () => {
        const OUTSIDER = 'f0000000-0000-4000-8000-00000000000f';
        const OUTSIDER_DEVICE = 'f1000000-0000-4000-8000-00000000001f';
        const SECOND_DEVICE = 'e2000000-0000-4000-8000-00000000002e';
        let trust: TrustStoreService;

        const numberFor = (mine: IdentityBundle[], peer: IdentityBundle[]) =>
            safetyNumber(
                userFingerprintMaterial(mine.map((b) => b.signingPublic)),
                userFingerprintMaterial(peer.map((b) => b.signingPublic))
            );

        function entryFor(userId: string, deviceId: string, bundle: IdentityBundle): RosterEntry {
            return {
                user_id: userId,
                device_id: deviceId,
                identity_key_id: uuidv4(),
                identity_public_key: b64uEncode(bundle.identityPublic),
                signing_public_key: b64uEncode(bundle.signingPublic),
                identity_key_signature: b64uEncode(bundle.identityKeySignature),
                signed_prekey_public: bundle.prekeyPublic ? b64uEncode(bundle.prekeyPublic) : null,
                signed_prekey_signature: bundle.signedPrekeySignature ? b64uEncode(bundle.signedPrekeySignature) : null,
            };
        }

        /** A self-consistent roster with the hash the server would store — what a lying server can produce. */
        function roster(...members: RosterEntry[]): ChatRoster {
            return { chat_id: CHAT, current_epoch: 1, member_set_hash: computeMemberSetHash(members), members };
        }

        const failureOf = (promise: Promise<unknown>) =>
            promise.then(
                () => null,
                (error: unknown) => error
            );

        const wrappedTo = () =>
            cryptoApi.publishSenderKey.calls.mostRecent().args[2].grants.map((g) => g.recipient_device_id);

        beforeEach(() => {
            trust = TestBed.inject(TrustStoreService);
            cryptoApi.publishSenderKey.and.returnValue(of({}));
        });

        describe('G1: user ids the chat does not contain', () => {
            it('refuses a ghost device under a third user id in a private chat, though the verified number is unchanged', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                trust.markVerified(USER, SENDER_USER, numberFor([mine], [peer]));
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });

                // Server-minted, validly self-bound, and the commitment recomputed to include it.
                const ghost = generateIdentity(OUTSIDER, OUTSIDER_DEVICE);
                cryptoApi.getRoster.and.returnValue(
                    of(
                        roster(
                            entryFor(USER, DEVICE, mine),
                            entryFor(SENDER_USER, SENDER_DEVICE, peer),
                            entryFor(OUTSIDER, OUTSIDER_DEVICE, ghost)
                        )
                    )
                );

                const failure = await failureOf(service.ensureSenderChain(CHAT, 1));

                expect(failure).toBeInstanceOf(MembershipMismatchError);
                expect((failure as RosterVerificationError).code).toBe('MEMBERSHIP_MISMATCH');
                expect((failure as Error).message).toContain(OUTSIDER_DEVICE);
                expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
                expect(sleep).not.toHaveBeenCalled();
            });

            it('refuses to replace a private pin with a different counterpart, and keeps the pin', async () => {
                const mine = await unlockWithBundle(true);
                const ghost = generateIdentity(OUTSIDER, OUTSIDER_DEVICE);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                expect(() =>
                    service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: OUTSIDER })
                ).toThrowError(MembershipMismatchError);
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(OUTSIDER, OUTSIDER_DEVICE, ghost)))
                );

                await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(RosterVerificationError);
                expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
            });

            it('refuses a roster that leaves us out entirely', async () => {
                await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(of(roster(entryFor(SENDER_USER, SENDER_DEVICE, peer))));

                const failure = await failureOf(service.ensureSenderChain(CHAT, 1));

                expect(failure).toBeInstanceOf(RosterVerificationError);
                expect((failure as Error).message).toContain('does not include your own devices');
                expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
            });

            it('checks a group roster against a freshly fetched participant list', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const ghost = generateIdentity(OUTSIDER, OUTSIDER_DEVICE);
                const resolve = jasmine.createSpy('resolve').and.resolveTo([USER, SENDER_USER]);
                service.expectMembers(CHAT, { kind: 'group', resolve });
                cryptoApi.getRoster.and.returnValue(
                    of(
                        roster(
                            entryFor(USER, DEVICE, mine),
                            entryFor(SENDER_USER, SENDER_DEVICE, peer),
                            entryFor(OUTSIDER, OUTSIDER_DEVICE, ghost)
                        )
                    )
                );

                await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(MembershipMismatchError);
                // Re-read once (roster and participants) before raising: item 8's honest race.
                expect(resolve).toHaveBeenCalledTimes(2);
                expect(cryptoApi.getRoster).toHaveBeenCalledTimes(2);
                expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();

                // The same user once the participant list says they joined: a member, not an intruder.
                resolve.and.resolveTo([USER, SENDER_USER, OUTSIDER]);
                await service.ensureSenderChain(CHAT, 1);
                expect(resolve).toHaveBeenCalledTimes(3);
                expect(wrappedTo()).toContain(OUTSIDER_DEVICE);
            });

            it('fails closed, without a roster alarm, when the chat membership is not known', async () => {
                await unlockWithBundle(true);

                const failure = await failureOf(service.ensureSenderChain(CHAT, 1));

                expect(failure).toBeInstanceOf(MembershipUnconfirmedError);
                expect(failure).not.toBeInstanceOf(RosterVerificationError);
                expect(cryptoApi.getRoster).not.toHaveBeenCalled();
                expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
            });

            it('forgets every expectation on lock', async () => {
                await unlockWithBundle(true);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });

                await service.lock();
                await unlockWithBundle(true);

                await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(MembershipUnconfirmedError);
            });
        });

        describe('G2: the send path reads the freshest stored record', () => {
            it('blocks on a verification another tab stored, before any storage event arrives', async () => {
                const mine = await unlockWithBundle(true);
                const original = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const planted = generateIdentity(SENDER_USER, SENDER_DEVICE);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                // Written by another tab: this tab's TrustStoreService has never seen it.
                localStorage.setItem(
                    'ns.trusted_peers',
                    JSON.stringify({
                        [`${USER}:${SENDER_USER}`]: {
                            safetyNumber: numberFor([mine], [original]),
                            verifiedAt: '2026-01-01T00:00:00Z',
                        },
                    })
                );
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, planted)))
                );

                await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(KeyChangedError);
                expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
            });
        });

        describe('G3: a verification retires chains wrapped before it', () => {
            it('reuses a cached chain while nothing the user confirmed has changed', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, peer)))
                );

                const first = await service.ensureSenderChain(CHAT, 1);
                const second = await service.ensureSenderChain(CHAT, 1);

                expect(second).toBe(first);
                expect(cryptoApi.getRoster).toHaveBeenCalledTimes(1);
                expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
            });

            /**
             * The scenario from the review: while B was unverified the roster carried a ghost device
             * for B and the chain was wrapped to it. The user then verifies B from the number the key
             * lookup shows (B's real device only). Without re-checking, the rest of the epoch would go
             * out on the chain the ghost already holds.
             */
            it('re-verifies the roster after the user verifies a peer, and refuses the ghost it now exposes', async () => {
                const mine = await unlockWithBundle(true);
                const real = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const ghost = generateIdentity(SENDER_USER, SECOND_DEVICE);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(
                        roster(
                            entryFor(USER, DEVICE, mine),
                            entryFor(SENDER_USER, SENDER_DEVICE, real),
                            entryFor(SENDER_USER, SECOND_DEVICE, ghost)
                        )
                    )
                );
                await service.ensureSenderChain(CHAT, 1);
                expect(wrappedTo()).withContext('trust on first use').toContain(SECOND_DEVICE);

                trust.markVerified(USER, SENDER_USER, numberFor([mine], [real]));

                const failure = await failureOf(service.ensureSenderChain(CHAT, 1));
                expect(failure).toBeInstanceOf(KeyChangedError);
                expect(cryptoApi.getRoster).toHaveBeenCalledTimes(2);
                expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
            });

            it('republishes after a verification even when the roster is clean', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, peer)))
                );
                const first = await service.ensureSenderChain(CHAT, 1);

                trust.markVerified(USER, SENDER_USER, numberFor([mine], [peer]));
                const second = await service.ensureSenderChain(CHAT, 1);

                expect(second.senderKeyId).not.toBe(first.senderKeyId);
                expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(2);
                // And the fresh chain is cached again until the next change.
                expect(await service.ensureSenderChain(CHAT, 1)).toBe(second);
            });

            it('retires cached chains when a verification arrives from another tab', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, peer)))
                );
                const first = await service.ensureSenderChain(CHAT, 1);

                localStorage.setItem(
                    'ns.trusted_peers',
                    JSON.stringify({
                        [`${USER}:${SENDER_USER}`]: {
                            safetyNumber: numberFor([mine], [peer]),
                            verifiedAt: '2026-01-01T00:00:00Z',
                        },
                    })
                );
                window.dispatchEvent(new StorageEvent('storage', { key: 'ns.trusted_peers' }));

                expect((await service.ensureSenderChain(CHAT, 1)).senderKeyId).not.toBe(first.senderKeyId);
            });

            it('invalidateOwnChains forces every chat to republish', async () => {
                const mine = await unlockWithBundle(true);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(of(roster(entryFor(USER, DEVICE, mine))));
                const first = await service.ensureSenderChain(CHAT, 1);

                service.invalidateOwnChains();

                expect((await service.ensureSenderChain(CHAT, 1)).senderKeyId).not.toBe(first.senderKeyId);
            });
        });

        describe('G5: a key lookup cannot clear what the roster showed', () => {
            it('keeps the change and its blocking number when the batch lookup returns the old keys', async () => {
                const mine = await unlockWithBundle(true);
                const original = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const planted = generateIdentity(SENDER_USER, SENDER_DEVICE);
                trust.markVerified(USER, SENDER_USER, numberFor([mine], [original]));
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, planted)))
                );
                await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(KeyChangedError);

                // The equivocating answer to the safety-number screen's lookup.
                cryptoApi.getKeysBatch.and.returnValue(
                    of([publicKeyFor(USER, DEVICE, mine), publicKeyFor(SENDER_USER, SENDER_DEVICE, original)])
                );
                expect((await service.computeSafetyNumber(SENDER_USER)).number).toBe(numberFor([mine], [original]));

                expect(TestBed.inject(KeyChangeStateService).observedState(USER, SENDER_USER)?.kind).toBe('changed');
                expect(TestBed.inject(KeyChangeStateService).blockingNumber(USER, SENDER_USER)).toBe(
                    numberFor([mine], [planted])
                );
            });
        });

        describe('G6: a device under our own user id', () => {
            /** `GET /crypto/identity/me` as it would list a device of ours (bundle fields unused here). */
            const ownRow = (deviceId: string, bundle: IdentityBundle, isActive = true): OwnIdentity => ({
                ...publicKeyFor(USER, deviceId, bundle),
                is_active: isActive,
                encrypted_private_bundle: '',
                kdf_params: {} as OwnIdentity['kdf_params'],
                created_at: '2026-01-01T00:00:00Z',
                signed_prekey_created_at: null,
                display_name: null,
            });

            /** Round 2, item 5: refused whatever anyone's verification state. */
            it('refuses a device under our id that no device list of ours contains, with no verified peer', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const ghostOfMine = generateIdentity(USER, SECOND_DEVICE);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(
                        roster(
                            entryFor(USER, DEVICE, mine),
                            entryFor(USER, SECOND_DEVICE, ghostOfMine),
                            entryFor(SENDER_USER, SENDER_DEVICE, peer)
                        )
                    )
                );

                const failure = await failureOf(service.ensureSenderChain(CHAT, 1));

                expect(failure).toBeInstanceOf(UnknownOwnDeviceError);
                expect((failure as RosterVerificationError).code).toBe('OWN_DEVICE_UNKNOWN');
                // The fresh device list was consulted before raising.
                expect(cryptoApi.getOwnIdentities).toHaveBeenCalledTimes(2);
                expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
            });

            it('accepts a device of ours added since unlock, and attributes a verified number change to it', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const newPhone = generateIdentity(USER, SECOND_DEVICE);
                trust.markVerified(USER, SENDER_USER, numberFor([mine], [peer]));
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getOwnIdentities.and.returnValue(of([ownRow(DEVICE, mine), ownRow(SECOND_DEVICE, newPhone)]));
                cryptoApi.getRoster.and.returnValue(
                    of(
                        roster(
                            entryFor(USER, DEVICE, mine),
                            entryFor(USER, SECOND_DEVICE, newPhone),
                            entryFor(SENDER_USER, SENDER_DEVICE, peer)
                        )
                    )
                );

                const failure = (await failureOf(service.ensureSenderChain(CHAT, 1))) as KeyChangedError;

                expect(failure).toBeInstanceOf(KeyChangedError);
                expect(failure.ownDevicesChanged).toBeTrue();
                expect(failure.message).toContain('Your own device list changed');
                expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
            });

            it("does not flag our own devices when only the peer's key changed", async () => {
                const mine = await unlockWithBundle(true);
                const original = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const planted = generateIdentity(SENDER_USER, SENDER_DEVICE);
                trust.markVerified(USER, SENDER_USER, numberFor([mine], [original]));
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, planted)))
                );

                const failure = (await failureOf(service.ensureSenderChain(CHAT, 1))) as KeyChangedError;

                expect(failure.ownDevicesChanged).toBeFalse();
            });

            /** Round 2, item 9: only *extra* keys count; a revoked device merely being absent does not. */
            it('does not flag a device of ours that is simply missing from the roster', async () => {
                const revoked = generateIdentity(USER, SECOND_DEVICE);
                // The unlock-time list holds both devices; the second is then revoked this session.
                const mine = await unlockWithBundle(true, [ownRow(SECOND_DEVICE, revoked)]);
                const original = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const planted = generateIdentity(SENDER_USER, SENDER_DEVICE);
                service.noteOwnDeviceRevoked(SECOND_DEVICE);
                trust.markVerified(USER, SENDER_USER, numberFor([mine], [original]));
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, planted)))
                );

                const failure = (await failureOf(service.ensureSenderChain(CHAT, 1))) as KeyChangedError;

                expect(failure).toBeInstanceOf(KeyChangedError);
                expect(failure.ownDevicesChanged).toBeFalse();
            });

            it('no longer explains a revoked device as ours once it was revoked this session', async () => {
                const revoked = generateIdentity(USER, SECOND_DEVICE);
                const mine = await unlockWithBundle(true, [ownRow(SECOND_DEVICE, revoked)]);
                service.noteOwnDeviceRevoked(SECOND_DEVICE);
                // The fresh list now marks it inactive, yet the roster still carries it.
                cryptoApi.getOwnIdentities.and.returnValue(
                    of([ownRow(DEVICE, mine), ownRow(SECOND_DEVICE, revoked, false)])
                );
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(USER, SECOND_DEVICE, revoked)))
                );

                await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(UnknownOwnDeviceError);
            });

            it('reports an unknown own device from the safety-number lookup too', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const ghostOfMine = generateIdentity(USER, SECOND_DEVICE);
                cryptoApi.getKeysBatch.and.returnValue(
                    of([
                        publicKeyFor(USER, DEVICE, mine),
                        publicKeyFor(USER, SECOND_DEVICE, ghostOfMine),
                        publicKeyFor(SENDER_USER, SENDER_DEVICE, peer),
                    ])
                );

                expect((await service.computeSafetyNumber(SENDER_USER)).ownDevicesUnknown).toBeTrue();

                cryptoApi.getKeysBatch.and.returnValue(
                    of([publicKeyFor(USER, DEVICE, mine), publicKeyFor(SENDER_USER, SENDER_DEVICE, peer)])
                );
                expect((await service.computeSafetyNumber(SENDER_USER)).ownDevicesUnknown).toBeFalse();
            });

            /** Round 3, N: a device our own list confirms is a notice, not an alarm. */
            it('notes a device added to our account since unlock without refusing it', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const newPhone = generateIdentity(USER, SECOND_DEVICE);
                cryptoApi.getOwnIdentities.and.returnValue(of([ownRow(DEVICE, mine), ownRow(SECOND_DEVICE, newPhone)]));
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(
                        roster(
                            entryFor(USER, DEVICE, mine),
                            entryFor(USER, SECOND_DEVICE, newPhone),
                            entryFor(SENDER_USER, SENDER_DEVICE, peer)
                        )
                    )
                );
                expect(service.ownDevicesAdded()).toBeFalse();

                await service.ensureSenderChain(CHAT, 1);

                expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
                expect(service.ownDevicesAdded()).toBeTrue();

                cryptoApi.getKeysBatch.and.returnValue(
                    of([
                        publicKeyFor(USER, DEVICE, mine),
                        publicKeyFor(USER, SECOND_DEVICE, newPhone),
                        publicKeyFor(SENDER_USER, SENDER_DEVICE, peer),
                    ])
                );
                const result = await service.computeSafetyNumber(SENDER_USER);
                expect(result.ownDevicesAdded).toBeTrue();
                expect(result.ownDevicesUnknown).toBeFalse();

                await service.lock();
                expect(service.ownDevicesAdded()).toBeFalse();
            });

            /** C3: the notice is lowered by acknowledging it, and the same device does not raise it again. */
            it('lowers the added-device notice on acknowledgement, until a different device turns up', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const newPhone = generateIdentity(USER, SECOND_DEVICE);
                const THIRD_DEVICE = 'e3000000-0000-4000-8000-00000000003e';
                const tablet = generateIdentity(USER, THIRD_DEVICE);
                cryptoApi.getOwnIdentities.and.returnValue(
                    of([ownRow(DEVICE, mine), ownRow(SECOND_DEVICE, newPhone), ownRow(THIRD_DEVICE, tablet)])
                );
                const lookup = (...extra: [string, IdentityBundle][]) =>
                    cryptoApi.getKeysBatch.and.returnValue(
                        of([
                            publicKeyFor(USER, DEVICE, mine),
                            ...extra.map(([id, bundle]) => publicKeyFor(USER, id, bundle)),
                            publicKeyFor(SENDER_USER, SENDER_DEVICE, peer),
                        ])
                    );

                lookup([SECOND_DEVICE, newPhone]);
                await service.computeSafetyNumber(SENDER_USER);
                expect(service.ownDevicesAdded()).toBeTrue();

                service.acknowledgeOwnDevicesAdded();
                expect(service.ownDevicesAdded()).toBeFalse();

                const again = await service.computeSafetyNumber(SENDER_USER);
                expect(again.ownDevicesAdded).withContext('the screen still says what the number covers').toBeTrue();
                expect(service.ownDevicesAdded()).withContext('already acknowledged').toBeFalse();

                lookup([SECOND_DEVICE, newPhone], [THIRD_DEVICE, tablet]);
                await service.computeSafetyNumber(SENDER_USER);
                expect(service.ownDevicesAdded()).withContext('a device not yet acknowledged').toBeTrue();
            });

            it('exposes the added-device notice read-only', async () => {
                await unlockWithBundle(true);
                expect((service.ownDevicesAdded as unknown as { set?: unknown }).set).toBeUndefined();
            });

            /** C4: a failed fresh device list is "could not check", not "unknown device". */
            it('reports our own devices as unchecked, not unknown, when the fresh device list fails', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const extraOfMine = generateIdentity(USER, SECOND_DEVICE);
                cryptoApi.getKeysBatch.and.returnValue(
                    of([
                        publicKeyFor(USER, DEVICE, mine),
                        publicKeyFor(USER, SECOND_DEVICE, extraOfMine),
                        publicKeyFor(SENDER_USER, SENDER_DEVICE, peer),
                    ])
                );
                cryptoApi.getOwnIdentities.and.returnValue(throwError(() => new HttpErrorResponse({ status: 503 })));

                const result = await service.computeSafetyNumber(SENDER_USER);

                expect(result.ownDevicesUnchecked).toBeTrue();
                expect(result.ownDevicesUnknown).toBeFalse();
                expect(result.ownDevicesAdded).withContext('not confirmed as ours either').toBeFalse();
                expect(service.ownDevicesAdded()).toBeFalse();
            });

            it('does not report our own devices as unchecked when there is nothing to check', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                cryptoApi.getKeysBatch.and.returnValue(
                    of([publicKeyFor(USER, DEVICE, mine), publicKeyFor(SENDER_USER, SENDER_DEVICE, peer)])
                );
                cryptoApi.getOwnIdentities.and.returnValue(throwError(() => new HttpErrorResponse({ status: 503 })));

                const result = await service.computeSafetyNumber(SENDER_USER);

                expect(result.ownDevicesUnchecked).toBeFalse();
                expect(result.ownDevicesUnknown).toBeFalse();
            });
        });

        /**
         * S3: the wrap and the upload are awaited, and a verification can land in another tab during
         * either. The chain was checked against the confirmations from before it, so it must not be
         * cached or returned; the publish is redone from a fresh roster read.
         */
        describe('S3: a verification landing while a chain is being published', () => {
            /** Simulates another tab confirming a number: storage only, no event yet. */
            function confirmInAnotherTab(peerId: string, number: string): void {
                const stored = JSON.parse(localStorage.getItem('ns.trusted_peers') ?? '{}') as Record<string, unknown>;
                stored[`${USER}:${peerId}`] = { safetyNumber: number, verifiedAt: new Date().toISOString() };
                localStorage.setItem('ns.trusted_peers', JSON.stringify(stored));
            }

            it('does not use the chain, and republishes against a re-checked roster', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, peer)))
                );
                let uploads = 0;
                cryptoApi.publishSenderKey.and.callFake(() => {
                    if (++uploads === 1) {
                        // Someone unrelated to this chat is verified mid-upload.
                        confirmInAnotherTab(OUTSIDER, numberFor([mine], [generateIdentity(OUTSIDER, OUTSIDER_DEVICE)]));
                    }
                    return of({}) as never;
                });

                const chain = await service.ensureSenderChain(CHAT, 1);

                expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(2);
                expect(cryptoApi.getRoster).toHaveBeenCalledTimes(2);
                expect(chain.senderKeyId)
                    .withContext('the chain from the re-checked publish, not the first one')
                    .toBe(cryptoApi.publishSenderKey.calls.mostRecent().args[2].sender_key_id);
                expect(await service.ensureSenderChain(CHAT, 1))
                    .withContext('and it is the one cached')
                    .toBe(chain);
            });

            it('refuses the send when the verification made mid-publish exposes a changed key', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const original = generateIdentity(SENDER_USER, SENDER_DEVICE);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                cryptoApi.getRoster.and.returnValue(
                    of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, peer)))
                );
                cryptoApi.publishSenderKey.and.callFake(() => {
                    // The user confirms, elsewhere, a number this roster's keys do not derive.
                    confirmInAnotherTab(SENDER_USER, numberFor([mine], [original]));
                    return of({}) as never;
                });

                const failure = await failureOf(service.ensureSenderChain(CHAT, 1));

                expect(failure).toBeInstanceOf(KeyChangedError);
                expect(cryptoApi.publishSenderKey)
                    .withContext('only the first, discarded upload')
                    .toHaveBeenCalledTimes(1);
            });
        });

        /** Round 2, item 1: a private expectation can never become a group one. */
        describe('private pin versus a re-labelled chat', () => {
            it('refuses a group expectation over a private one', async () => {
                await unlockWithBundle(true);
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });

                expect(() =>
                    service.expectMembers(CHAT, { kind: 'group', resolve: async () => [USER, SENDER_USER, OUTSIDER] })
                ).toThrowError(MembershipMismatchError);
            });
        });

        /** Round 2, item 4: refusals are per chat, and clearing the verification does not lift one. */
        describe('per-chat refusals', () => {
            const OTHER_CHAT = 'c1000000-0000-4000-8000-0000000000c1';

            it("keeps refusing a chat's ghost after another chat's honest roster and a cleared verification", async () => {
                const mine = await unlockWithBundle(true);
                const real = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const ghost = generateIdentity(SENDER_USER, SECOND_DEVICE);
                trust.markVerified(USER, SENDER_USER, numberFor([mine], [real]));
                service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                service.expectMembers(OTHER_CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                const ghostRoster = roster(
                    entryFor(USER, DEVICE, mine),
                    entryFor(SENDER_USER, SENDER_DEVICE, real),
                    entryFor(SENDER_USER, SECOND_DEVICE, ghost)
                );
                const honestRoster = {
                    ...roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, real)),
                    chat_id: OTHER_CHAT,
                };
                cryptoApi.getRoster.and.callFake((id: string) => of(id === CHAT ? ghostRoster : honestRoster));

                await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(KeyChangedError);
                const refused = numberFor([mine], [real, ghost]);

                // The other chat's honest roster passes and observes the verified number...
                await service.ensureSenderChain(OTHER_CHAT, 1);
                // ...without erasing what CHAT was refused on.
                expect(TestBed.inject(KeyChangeStateService).blockingNumber(USER, SENDER_USER, CHAT)).toBe(refused);
                expect(TestBed.inject(KeyChangeStateService).observedState(USER, SENDER_USER)?.kind).toBe('changed');

                // Clearing the verification must not turn the ghost into trust-on-first-use.
                expect(trust.forget(USER, SENDER_USER)).withContext('refused while the refusal holds').toBe('refused');
                await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(KeyChangedError);
                expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);

                // Only confirming that exact number lifts it.
                trust.markVerified(USER, SENDER_USER, refused);
                await service.ensureSenderChain(CHAT, 1);
                expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(2);
            });

            /**
             * Round 3, C: N0 verified -> refused on N1 -> the user confirms N2 (the key changed again,
             * or they compared elsewhere). The chat must not stay blocked on the stale N1: a re-check
             * decides afresh — unblocking if the roster now derives N2, re-refusing on N2 otherwise.
             */
            describe('after a different number is confirmed (N0 -> N1 refused -> N2 confirmed)', () => {
                let mine: IdentityBundle;
                let n1Keys: IdentityBundle;
                let n2Keys: IdentityBundle;
                let keyChange: KeyChangeStateService;

                beforeEach(async () => {
                    mine = await unlockWithBundle(true);
                    keyChange = TestBed.inject(KeyChangeStateService);
                    const n0Keys = generateIdentity(SENDER_USER, SENDER_DEVICE);
                    n1Keys = generateIdentity(SENDER_USER, SENDER_DEVICE);
                    n2Keys = generateIdentity(SENDER_USER, SENDER_DEVICE);
                    trust.markVerified(USER, SENDER_USER, numberFor([mine], [n0Keys]));
                    service.expectMembers(CHAT, { kind: 'private', selfId: USER, peerId: SENDER_USER });
                    cryptoApi.getRoster.and.returnValue(
                        of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, n1Keys)))
                    );
                    await expectAsync(service.ensureSenderChain(CHAT, 1)).toBeRejectedWithError(KeyChangedError);
                    trust.markVerified(USER, SENDER_USER, numberFor([mine], [n2Keys]));
                });

                it('no longer reports the stale refusal', () => {
                    expect(keyChange.refusalFor(CHAT, USER, SENDER_USER)).toBeNull();
                });

                it('unblocks on re-check when the roster now derives N2', async () => {
                    cryptoApi.getRoster.and.returnValue(
                        of(roster(entryFor(USER, DEVICE, mine), entryFor(SENDER_USER, SENDER_DEVICE, n2Keys)))
                    );

                    await service.recheckRoster(CHAT, 1);

                    expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
                    expect(keyChange.observedState(USER, SENDER_USER)?.kind).toBe('verified');
                    expect(keyChange.refusedPeers(CHAT, USER)).toEqual([]);
                });

                it('re-refuses on N2 when the roster still derives N1', async () => {
                    const failure = (await failureOf(service.recheckRoster(CHAT, 1))) as KeyChangedError;

                    expect(failure).toBeInstanceOf(KeyChangedError);
                    expect(failure.peers[0].previous).toBe(numberFor([mine], [n2Keys]));
                    expect(keyChange.refusalFor(CHAT, USER, SENDER_USER)?.current).toBe(numberFor([mine], [n1Keys]));
                    expect(cryptoApi.publishSenderKey).not.toHaveBeenCalled();
                });
            });
        });

        describe("G7: a deleted account's retained keys", () => {
            it('leaves inactive keys out of the safety number', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const retired = generateIdentity(SENDER_USER, SECOND_DEVICE);
                cryptoApi.getKeysBatch.and.returnValue(
                    of([
                        publicKeyFor(USER, DEVICE, mine),
                        publicKeyFor(SENDER_USER, SENDER_DEVICE, peer),
                        { ...publicKeyFor(SENDER_USER, SECOND_DEVICE, retired), is_active: false },
                    ])
                );

                expect((await service.computeSafetyNumber(SENDER_USER)).number).toBe(numberFor([mine], [peer]));
            });

            it('does not report a change on ingest because of an inactive retained key', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                const retired = generateIdentity(SENDER_USER, SECOND_DEVICE);
                trust.markVerified(USER, SENDER_USER, numberFor([mine], [peer]));
                cryptoApi.getKeysBatch.and.returnValue(
                    of([
                        publicKeyFor(USER, DEVICE, mine),
                        publicKeyFor(SENDER_USER, SENDER_DEVICE, peer),
                        { ...publicKeyFor(SENDER_USER, SECOND_DEVICE, retired), is_active: false },
                    ])
                );
                const dist = await buildDistribution({
                    epoch: 1,
                    senderIdentity: peer,
                    recipientPublic: mine.prekeyPublic!,
                    recipientDeviceId: DEVICE,
                });

                await service.ingestDistributions(CHAT, [dist]);

                expect(TestBed.inject(KeyChangeStateService).observedState(USER, SENDER_USER)?.kind).toBe('verified');
            });

            it('notes nothing on ingest when the batch carries no key of ours', async () => {
                const mine = await unlockWithBundle(true);
                const peer = generateIdentity(SENDER_USER, SENDER_DEVICE);
                cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, peer)]));
                const dist = await buildDistribution({
                    epoch: 1,
                    senderIdentity: peer,
                    recipientPublic: mine.prekeyPublic!,
                    recipientDeviceId: DEVICE,
                });

                await service.ingestDistributions(CHAT, [dist]);

                expect(service.getReceiverChain(CHAT, 1, dist.sender_key_id)).toBeDefined();
                expect(TestBed.inject(KeyChangeStateService).observedState(USER, SENDER_USER)).toBeNull();
            });
        });
    });

    describe('persisted skipped keys (TB-32)', () => {
        let store: SkippedKeyStore;
        let dist: Distribution;

        /** A "page reload": new service and new store instance (empty memory), same IndexedDB. */
        function reload(): { keyStore: KeyStoreService; store: SkippedKeyStore } {
            const injector = Injector.create({
                parent: TestBed.inject(Injector),
                providers: [KeyStoreService, SkippedKeyStore],
            });
            return { keyStore: injector.get(KeyStoreService), store: injector.get(SkippedKeyStore) };
        }

        const chainId = () => `${USER}|${CHAT}|${dist.epoch}|${dist.sender_key_id}`;

        beforeEach(async () => {
            const bundle = await unlockWithBundle(true);
            store = TestBed.inject(SkippedKeyStore);
            const senderIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE);
            cryptoApi.getKeysBatch.and.returnValue(of([publicKeyFor(SENDER_USER, SENDER_DEVICE, senderIdentity)]));
            dist = await buildDistribution({
                epoch: 1,
                senderIdentity,
                recipientPublic: bundle.prekeyPublic!,
                recipientDeviceId: DEVICE,
            });
            await service.ingestDistributions(CHAT, [dist]);
        });

        /** Message 5 arrives first: 0-4 are skipped and must reach storage, wrapped. */
        async function skipFirstFive(): Promise<void> {
            service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)!.messageKeyFor(5);
            await until(async () => (await store.forChain(chainId())).length === 5);
        }

        async function reloadAndIngest() {
            const after = reload();
            expect(await after.keyStore.unlock(USER, PASSWORD)).toBeTrue();
            await after.keyStore.ingestDistributions(CHAT, [dist]);
            return {
                ...after,
                chain: after.keyStore.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)!,
            };
        }

        it('writes only wrapped entries: no key bytes appear in storage', async () => {
            await skipFirstFive();
            const chain = service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)!;
            const plain = b64uEncode(chain.skipped.get(2)!.key);

            const rows = await store.forChain(chainId());
            expect(JSON.stringify(rows)).not.toContain(plain);
            expect(new Set(rows.map((r) => r.iv)).size)
                .withContext('fresh IV per entry')
                .toBe(5);
        });

        it('opens a late message after a simulated reload', async () => {
            const before = service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)!;
            before.messageKeyFor(5);
            const expected = before.skipped.get(2)!;
            await until(async () => (await store.forChain(chainId())).length === 5);

            const { chain } = await reloadAndIngest();

            // Seeded from storage before any message has been processed.
            expect(chain.skipped.size).toBe(5);
            const key = chain.messageKeyFor(2);
            expect(key.key).toEqual(expected.key);
            expect(key.nonce).toEqual(expected.nonce);
        });

        it('deletes an entry once it is consumed, and never yields it twice', async () => {
            await skipFirstFive();
            const chain = service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)!;

            chain.messageKeyFor(2);
            await until(async () => (await store.forChain(chainId())).length === 4);

            expect((await store.forChain(chainId())).map((r) => r.index)).not.toContain(2);
            expect(() => chain.messageKeyFor(2)).toThrowError(/already consumed/);
        });

        it('rejects and deletes an entry whose ciphertext was tampered with', async () => {
            await skipFirstFive();
            const row = (await store.forChain(chainId())).find((r) => r.index === 2)!;
            const bytes = b64uDecode(row.ct);
            bytes[0] ^= 1;
            await store.put({ ...row, ct: b64uEncode(bytes) });

            const { chain, store: after } = await reloadAndIngest();

            expect(chain.skipped.size).toBe(4);
            expect(chain.skipped.has(2)).toBeFalse();
            await until(async () => (await after.forChain(chainId())).every((r) => r.index !== 2));
        });

        it('rejects an entry swapped to another index', async () => {
            await skipFirstFive();
            const rows = await store.forChain(chainId());
            const one = rows.find((r) => r.index === 1)!;
            const three = rows.find((r) => r.index === 3)!;
            // Index 3's slot now holds index 1's valid-looking ciphertext.
            await store.put({ ...three, iv: one.iv, ct: one.ct });

            const { chain } = await reloadAndIngest();

            expect(chain.skipped.has(3)).toBeFalse();
            expect(chain.skipped.has(1)).toBeTrue();
        });

        it('rejects an entry whose record id no longer matches its location', async () => {
            await skipFirstFive();
            const row = (await store.forChain(chainId())).find((r) => r.index === 1)!;
            // Filed under index 4's id while its own index field still says 1: id and index disagree.
            await store.put({ ...row, id: `${chainId()}|4` });

            const { chain } = await reloadAndIngest();

            // The genuine index-4 row was overwritten by the forgery, which cannot open at index 4.
            expect(chain.skipped.has(4)).toBeFalse();
            expect(chain.skipped.size).toBe(4);
        });

        it('erases rows wrapped under the old KEK after a password change, and writes the new KEK from then on', async () => {
            await skipFirstFive();
            const identity = service.currentIdentity!;
            const newKek = crypto.getRandomValues(new Uint8Array(32));

            await service.completePasswordChange({
                encryptedPrivateBundle: 'x',
                kdfParams: identity.kdfParams,
                kek: newKek,
            } as never);

            expect(await store.count()).toBe(0);
            expect(service.currentIdentity!.kek).toEqual(newKek);

            // A later retention is written under the new KEK, so a reload with it restores the row.
            const chain = service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)!;
            chain.messageKeyFor(8);
            await until(async () => (await store.forChain(chainId())).length > 0);
            const row = (await store.forChain(chainId()))[0];
            const { unwrapSkippedKey } = await import('../crypto/skipped-wrap');
            await expectAsync(
                unwrapSkippedKey(
                    newKek,
                    {
                        userId: USER,
                        chatId: CHAT,
                        epoch: dist.epoch,
                        senderKeyId: dist.sender_key_id,
                        index: row.index,
                    },
                    row
                )
            ).toBeResolved();
        });

        it('resolves lock() only after storage is cleared, and logs a failed wipe', async () => {
            await skipFirstFive();
            await service.lock();
            expect(await store.count()).toBe(0);

            const logged = spyOn(console, 'error');
            spyOn(store, 'clear').and.resolveTo(false);
            await service.lock();
            expect(logged).toHaveBeenCalled();
        });

        it('wipes storage and memory on lock', async () => {
            await skipFirstFive();

            service.lock();

            await until(async () => (await store.count()) === 0);
            expect(service.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)).toBeUndefined();
        });

        it('keeps working, in memory, when IndexedDB is unavailable', async () => {
            const memoryOnly = Injector.create({
                parent: TestBed.inject(Injector),
                providers: [{ provide: SKIPPED_KEY_IDB, useValue: null }, KeyStoreService, SkippedKeyStore],
            });
            const keyStore = memoryOnly.get(KeyStoreService);
            const fallback = memoryOnly.get(SkippedKeyStore);
            expect(await keyStore.unlock(USER, PASSWORD)).toBeTrue();
            await keyStore.ingestDistributions(CHAT, [dist]);
            const chain = keyStore.getReceiverChain(CHAT, dist.epoch, dist.sender_key_id)!;

            chain.messageKeyFor(3);
            await until(async () => (await fallback.forChain(chainId())).length === 3);

            expect(fallback.isMemoryOnly).toBeTrue();
            expect(chain.messageKeyFor(1)).toBeDefined();
        });
    });
});

describe('SENDER_KEY_PUBLISH_POLICY defaults', () => {
    it('is 3 attempts with a 250 ms base, and sleeps on a real (here fake) timer', fakeAsync(() => {
        const policy = TestBed.inject(SENDER_KEY_PUBLISH_POLICY);
        expect(policy.maxAttempts).toBe(3);
        expect(policy.baseDelayMs).toBe(250);

        let woke = false;
        void policy.sleep(policy.baseDelayMs * 2 ** 1).then(() => (woke = true));
        tick(499);
        expect(woke).toBeFalse();
        tick(1);
        expect(woke).toBeTrue();
    }));
});

/** A minimal `PUT /crypto/identity/prekey` response; `rotatePrekey` only reads `device_id` off the
 *  request it built, not this response, but the API needs something to return. */
function rotateResponse(): PublicKey {
    return {
        user_id: USER,
        device_id: DEVICE,
        identity_key_id: uuidv4(),
        version: 1,
        identity_public_key: '',
        signing_public_key: '',
        identity_key_signature: '',
        signed_prekey_public: null,
        signed_prekey_signature: null,
    } as PublicKey;
}
