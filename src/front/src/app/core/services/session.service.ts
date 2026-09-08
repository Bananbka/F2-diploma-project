import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { UserProfile } from '../models/chat.model';
import { AuthApiService, RegisterRequest, RewrappedIdentity } from './auth-api.service';
import { CryptoApiService } from './crypto-api.service';
import { KeyStoreService, UnlockStageReporter } from './key-store.service';
import { MessageService } from './message.service';
import { WebSocketService } from './websocket.service';

/**
 * The v1 protocol does not use RSA, but `POST /auth/register` still requires the pre-migration
 * `public_key` / `encrypted_private_key` columns. Real key material is published separately to
 * `POST /crypto/identity` once the account can authenticate, so sending a marker here is more
 * honest than minting an RSA pair nothing will ever use.
 */
const LEGACY_KEY_PLACEHOLDER = 'legacy-rsa-unused-v1';

export interface RegisterInput {
    fullName: string;
    username: string;
    email: string;
    phoneNumber: string;
    password: string;
}

/**
 * Why an unlock did or did not succeed.
 *
 * `provisioned` is the first-login-after-registration case: the account exists but has no identity
 * for this device yet, so one is generated and published. It is not an error, and it must not be
 * reported as a bad password.
 */
export type UnlockOutcome = 'unlocked' | 'provisioned' | 'wrong-password';

/**
 * Who is signed in, and whether their keys are open.
 *
 * These are two separate facts and the UI depends on the distinction: a valid session cookie with a
 * locked key store can read the chat list but cannot decrypt a single message. Collapsing them
 * would let the app render an empty conversation as though there were nothing to read.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
    private readonly authApi = inject(AuthApiService);
    private readonly cryptoApi = inject(CryptoApiService);
    private readonly keyStore = inject(KeyStoreService);
    private readonly messages = inject(MessageService);
    private readonly ws = inject(WebSocketService);

    readonly user = signal<UserProfile | null>(null);
    /** False until the initial `me()` probe settles, so guards do not redirect on a cold reload. */
    readonly isRestored = signal(false);

    readonly isUnlocked = this.keyStore.isUnlocked;

    /**
     * Probe the cookie session once at startup.
     *
     * The key store is memory-only by design, so a surviving cookie lands the user on the unlock
     * screen rather than straight into their chats. That prompt is the security measure working.
     */
    async restore(): Promise<void> {
        try {
            this.user.set(await firstValueFrom(this.authApi.me()));
        } catch {
            this.user.set(null);
        } finally {
            this.isRestored.set(true);
        }
    }

    async register(input: RegisterInput): Promise<void> {
        const payload: RegisterRequest = {
            full_name: input.fullName,
            username: input.username,
            password: input.password,
            email: input.email,
            phone_number: input.phoneNumber,
            public_key: LEGACY_KEY_PLACEHOLDER,
            encrypted_private_key: LEGACY_KEY_PLACEHOLDER,
        };

        await firstValueFrom(this.authApi.register(payload));
    }

    /**
     * `POST /auth/register` already set the token cookies, so verifying promotes that same session
     * rather than starting a new one. The account is signed in from here — only its keys are missing.
     */
    async verifyEmail(email: string, otp: string): Promise<void> {
        this.user.set(await firstValueFrom(this.authApi.verifyEmail(email, otp)));
    }

    async resendVerificationEmail(): Promise<void> {
        await firstValueFrom(this.authApi.resendVerificationEmail());
    }

    async login(username: string, password: string): Promise<void> {
        this.user.set(await firstValueFrom(this.authApi.login({ username, password })));
    }

    /**
     * Open the key store, provisioning a first identity if this account has none.
     *
     * A brand-new account reaches here with nothing published, because registration happens before
     * the user can authenticate to `POST /crypto/identity`. Asking the server for the identity list
     * first is what separates "no keys yet" from "wrong password" — `KeyStoreService.unlock`
     * reports both as `false`.
     */
    async unlock(password: string, onStage?: UnlockStageReporter): Promise<UnlockOutcome> {
        const user = this.user();
        if (!user) {
            throw new Error('not signed in');
        }

        const identities = await firstValueFrom(this.cryptoApi.getOwnIdentities());

        if (identities.length === 0) {
            await onStage?.('deriving');
            await this.keyStore.createAndPublishIdentity(user.id, password);
            this.ws.connect();
            return 'provisioned';
        }

        const opened = await this.keyStore.unlock(user.id, password, onStage);
        if (!opened) {
            return 'wrong-password';
        }

        this.ws.connect();
        return 'unlocked';
    }

    /** Request a reset OTP. The account is matched on username **and** email together. */
    async forgotPassword(username: string, email: string): Promise<void> {
        await firstValueFrom(this.authApi.forgotPassword({ username, email }));
    }

    /**
     * Reset a forgotten password, destroying the identity.
     *
     * There is nothing to re-wrap: the bundle was sealed under the password the user no longer has,
     * so the server revokes every device and identity key. The legacy RSA columns still have to be
     * supplied, hence the placeholder.
     *
     * The caller's tokens die with it — the server sets `force_logout` and issues no new cookies — so
     * local state is cleared here and the user must sign in again. On that login they will have no
     * identity, and `unlock` provisions a fresh one.
     */
    async resetPassword(username: string, otp: string, newPassword: string): Promise<void> {
        await firstValueFrom(
            this.authApi.resetPassword({
                username,
                otp,
                new_password: newPassword,
                new_public_key: LEGACY_KEY_PLACEHOLDER,
                new_encrypted_private_key: LEGACY_KEY_PLACEHOLDER,
            })
        );

        this.ws.disconnect();
        this.keyStore.lock();
        this.messages.forgetOpened();
        this.user.set(null);
    }

    /**
     * Change a known password, keeping the identity.
     *
     * The bundle is re-sealed under the new password and sent in the same request. Two things make
     * that non-negotiable: the field is optional to the server, and the server cannot check that the
     * bundle actually opens — so omitting or mis-wrapping it locks the account out with a 200 OK.
     *
     * The re-wrap is therefore verified locally first, by unwrapping it with the new password before
     * anything is sent. A failure here is recoverable; the same failure server-side is not.
     */
    async changePassword(oldPassword: string, newPassword: string): Promise<void> {
        const identity = this.keyStore.currentIdentity;
        if (!identity) {
            throw new Error('key store is locked');
        }

        const identities = await firstValueFrom(this.cryptoApi.getOwnIdentities());
        const rewrapped: RewrappedIdentity[] = [];

        for (const published of identities) {
            const bundle = await this.keyStore.rewrapBundleFor(published, oldPassword, newPassword);
            rewrapped.push({
                device_id: published.device_id,
                encrypted_private_bundle: bundle.encryptedPrivateBundle,
                kdf_params: bundle.kdfParams as unknown as Record<string, unknown>,
            });
        }

        await firstValueFrom(
            this.authApi.changePassword({
                old_password: oldPassword,
                new_password: newPassword,
                rewrapped_identities: rewrapped,
            })
        );
    }

    async logout(): Promise<void> {
        try {
            await firstValueFrom(this.authApi.logout());
        } finally {
            // Local state is cleared even if the server call fails: leaving unwrapped private keys
            // in memory after the user asked to leave is the worse outcome. Retained plaintext goes
            // too — it would otherwise outlive the keys that produced it.
            this.ws.disconnect();
            this.keyStore.lock();
            this.messages.forgetOpened();
            this.user.set(null);
        }
    }
}
