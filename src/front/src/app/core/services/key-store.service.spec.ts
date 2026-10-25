import { HttpErrorResponse } from '@angular/common/http';
import { Injector } from '@angular/core';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

import { computeMemberSetHash, signDistribution, wrapChainKey } from '../crypto/grants';
import { generateIdentity, IdentityBundle, wrapPrivateBundle } from '../crypto/identity';
import { b64uDecode, b64uEncode } from '../crypto/primitives';
import { generateChainKey } from '../crypto/ratchet';
import {
    ChatRoster,
    Distribution,
    OwnIdentity,
    PrekeyRotateRequest,
    PublicKey,
    RosterEntry,
} from '../models/crypto.model';
import { CryptoApiService } from './crypto-api.service';
import { MemberSetMismatchError, RetryLimitExceededError, RosterVerificationError } from './crypto-errors';
import { KeyStoreService, SENDER_KEY_PUBLISH_POLICY } from './key-store.service';
import { SKIPPED_KEY_DB_NAME, SKIPPED_KEY_IDB, SkippedKeyStore } from './skipped-key-store.service';

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
}): Promise<Distribution> {
    const senderKeyId = uuidv4();
    // Throwaway chain-signing keypair, exactly as `ensureSenderChain` mints one per chain.
    const chainIdentity = generateIdentity(SENDER_USER, SENDER_DEVICE, false);
    const chainKey = generateChainKey();

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

describe('KeyStoreService', () => {
    // Each unlock runs a real 64 MiB Argon2id derivation; a few per test outgrow the 5 s default.
    const defaultTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    beforeAll(() => (jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000));
    afterAll(() => (jasmine.DEFAULT_TIMEOUT_INTERVAL = defaultTimeout));

    let service: KeyStoreService;
    let cryptoApi: jasmine.SpyObj<CryptoApiService>;
    let sleep: jasmine.Spy<(ms: number) => Promise<void>>;
    let dbName: string;
    const sealedBundles = new Map<
        boolean,
        { bundle: IdentityBundle; wrapped?: Awaited<ReturnType<typeof wrapPrivateBundle>> }
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
                { provide: SKIPPED_KEY_DB_NAME, useValue: dbName },
                { provide: SENDER_KEY_PUBLISH_POLICY, useValue: { maxAttempts: 3, baseDelayMs: 250, sleep } },
            ],
        });
        service = TestBed.inject(KeyStoreService);
    });

    afterEach(() => localStorage.clear());

    /** Unlocks the service against a freshly-sealed bundle this test fully controls. */
    async function unlockWithBundle(withPrekey: boolean): Promise<IdentityBundle> {
        localStorage.setItem('ns.device_id', DEVICE);

        // Sealing costs a full Argon2id run; the bundle is immutable, so seal each shape once.
        const cached = sealedBundles.get(withPrekey) ?? {
            bundle: generateIdentity(USER, DEVICE, withPrekey),
            wrapped: undefined as Awaited<ReturnType<typeof wrapPrivateBundle>> | undefined,
        };
        cached.wrapped ??= await wrapPrivateBundle(cached.bundle, PASSWORD);
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
        cryptoApi.getOwnIdentities.and.returnValue(of([own]));

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
