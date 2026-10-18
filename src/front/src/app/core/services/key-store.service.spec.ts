import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

import { signDistribution, wrapChainKey } from '../crypto/grants';
import { generateIdentity, IdentityBundle, wrapPrivateBundle } from '../crypto/identity';
import { b64uDecode, b64uEncode } from '../crypto/primitives';
import { generateChainKey } from '../crypto/ratchet';
import { Distribution, OwnIdentity, PrekeyRotateRequest, PublicKey } from '../models/crypto.model';
import { CryptoApiService } from './crypto-api.service';
import { KeyStoreService } from './key-store.service';

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

describe('KeyStoreService', () => {
    let service: KeyStoreService;
    let cryptoApi: jasmine.SpyObj<CryptoApiService>;

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

        TestBed.configureTestingModule({
            providers: [KeyStoreService, { provide: CryptoApiService, useValue: cryptoApi }],
        });
        service = TestBed.inject(KeyStoreService);
    });

    afterEach(() => localStorage.clear());

    /** Unlocks the service against a freshly-sealed bundle this test fully controls. */
    async function unlockWithBundle(withPrekey: boolean): Promise<IdentityBundle> {
        localStorage.setItem('ns.device_id', DEVICE);

        const bundle = generateIdentity(USER, DEVICE, withPrekey);
        const wrapped = await wrapPrivateBundle(bundle, PASSWORD);

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
