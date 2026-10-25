import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';

import { UserProfile } from '../models/chat.model';
import { AuthApiService } from './auth-api.service';
import { CryptoApiService } from './crypto-api.service';
import { KeyStoreService } from './key-store.service';
import { MessageService } from './message.service';
import { ProfileApiService } from './profile-api.service';
import { SessionService } from './session.service';
import { WebSocketService } from './websocket.service';

describe('SessionService.deleteAccount', () => {
    let session: SessionService;
    let profileApi: jasmine.SpyObj<ProfileApiService>;
    let keyStore: jasmine.SpyObj<KeyStoreService>;
    let messages: jasmine.SpyObj<MessageService>;
    let ws: jasmine.SpyObj<WebSocketService>;

    beforeEach(() => {
        profileApi = jasmine.createSpyObj<ProfileApiService>('ProfileApiService', ['deleteAccount']);
        keyStore = jasmine.createSpyObj<KeyStoreService>('KeyStoreService', ['lock', 'forgetDeviceId']);
        (keyStore as unknown as { isUnlocked: unknown }).isUnlocked = signal(true);
        messages = jasmine.createSpyObj<MessageService>('MessageService', ['forgetOpened']);
        ws = jasmine.createSpyObj<WebSocketService>('WebSocketService', ['disconnect']);

        TestBed.configureTestingModule({
            providers: [
                SessionService,
                { provide: ProfileApiService, useValue: profileApi },
                { provide: KeyStoreService, useValue: keyStore },
                { provide: MessageService, useValue: messages },
                { provide: WebSocketService, useValue: ws },
                { provide: AuthApiService, useValue: {} },
                { provide: CryptoApiService, useValue: {} },
            ],
        });

        session = TestBed.inject(SessionService);
        session.user.set({ id: 'u1' } as UserProfile);
    });

    it('tears down keys, plaintext, socket and the user once the server confirms', async () => {
        profileApi.deleteAccount.and.returnValue(of({ message: 'Account deleted.' }));

        await session.deleteAccount('pw');

        expect(profileApi.deleteAccount).toHaveBeenCalledWith('pw');
        expect(ws.disconnect).toHaveBeenCalled();
        expect(keyStore.lock).toHaveBeenCalled();
        expect(keyStore.forgetDeviceId).toHaveBeenCalled();
        expect(messages.forgetOpened).toHaveBeenCalled();
        expect(session.user()).toBeNull();
    });

    /** A wrong password must leave a live account fully usable: keys stay unlocked, user stays set. */
    it('changes nothing locally when the server refuses', async () => {
        profileApi.deleteAccount.and.returnValue(
            throwError(() => new HttpErrorResponse({ status: 401, error: { error_code: 'INVALID_PASSWORD' } }))
        );

        await expectAsync(session.deleteAccount('wrong')).toBeRejected();

        expect(keyStore.lock).not.toHaveBeenCalled();
        expect(keyStore.forgetDeviceId).not.toHaveBeenCalled();
        expect(ws.disconnect).not.toHaveBeenCalled();
        expect(session.user()).not.toBeNull();
    });
});

describe('SessionService socket session end (close code 4401)', () => {
    let session: SessionService;
    let authApi: { refresh: jasmine.Spy };
    let keyStore: jasmine.SpyObj<KeyStoreService>;
    let ws: { connect: jasmine.Spy; disconnect: jasmine.Spy; sessionEnded: Subject<void> };
    let router: jasmine.SpyObj<Router>;

    beforeEach(async () => {
        authApi = { refresh: jasmine.createSpy('refresh') };
        keyStore = jasmine.createSpyObj<KeyStoreService>('KeyStoreService', ['lock', 'unlock']);
        (keyStore as unknown as { isUnlocked: unknown }).isUnlocked = signal(true);
        keyStore.lock.and.resolveTo();
        keyStore.unlock.and.resolveTo(true);
        ws = {
            connect: jasmine.createSpy('connect'),
            disconnect: jasmine.createSpy('disconnect'),
            sessionEnded: new Subject<void>(),
        };
        router = jasmine.createSpyObj<Router>('Router', ['navigate']);

        TestBed.configureTestingModule({
            providers: [
                SessionService,
                { provide: AuthApiService, useValue: authApi },
                { provide: CryptoApiService, useValue: { getOwnIdentities: () => of([{}]) } },
                { provide: KeyStoreService, useValue: keyStore },
                { provide: MessageService, useValue: jasmine.createSpyObj('MessageService', ['forgetOpened']) },
                { provide: WebSocketService, useValue: ws },
                { provide: ProfileApiService, useValue: {} },
                { provide: Router, useValue: router },
            ],
        });
        session = TestBed.inject(SessionService);
        session.user.set({ id: 'u1' } as UserProfile);
        await session.unlock('pw'); // binds the socket-end handler and connects once
        ws.connect.calls.reset();
    });

    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    it('refreshes the token and reconnects once when that works', async () => {
        authApi.refresh.and.returnValue(of({}));

        ws.sessionEnded.next();
        await settle();

        expect(authApi.refresh).toHaveBeenCalledTimes(1);
        expect(ws.connect).toHaveBeenCalled();
        expect(keyStore.lock).not.toHaveBeenCalled();
    });

    it('locks the key store, drops the user and goes to login when the refresh fails', async () => {
        authApi.refresh.and.returnValue(throwError(() => new HttpErrorResponse({ status: 401 })));

        ws.sessionEnded.next();
        await settle();

        expect(keyStore.lock).toHaveBeenCalled();
        expect(session.user()).toBeNull();
        expect(router.navigate).toHaveBeenCalledWith(['/login']);
    });

    it('does not loop: a second 4401 straight after a refresh ends the session', async () => {
        authApi.refresh.and.returnValue(of({}));

        ws.sessionEnded.next();
        await settle();
        ws.sessionEnded.next();
        await settle();

        expect(authApi.refresh).toHaveBeenCalledTimes(1);
        expect(keyStore.lock).toHaveBeenCalled();
        expect(router.navigate).toHaveBeenCalledWith(['/login']);
    });
});

describe('SessionService.changePassword', () => {
    it('adopts the new KEK for this device only after the server accepts', async () => {
        const wrapped = { encryptedPrivateBundle: 'b', kdfParams: {}, kek: new Uint8Array(32) };
        const keyStore = jasmine.createSpyObj<KeyStoreService>('KeyStoreService', [
            'rewrapBundleFor',
            'completePasswordChange',
        ]);
        (keyStore as unknown as { isUnlocked: unknown }).isUnlocked = signal(true);
        Object.defineProperty(keyStore, 'currentIdentity', { value: { deviceId: 'd1' } });
        keyStore.rewrapBundleFor.and.resolveTo(wrapped as never);
        const changePassword = jasmine.createSpy('changePassword').and.returnValue(throwError(() => new Error('no')));

        TestBed.configureTestingModule({
            providers: [
                SessionService,
                { provide: AuthApiService, useValue: { changePassword } },
                { provide: CryptoApiService, useValue: { getOwnIdentities: () => of([{ device_id: 'd1' }]) } },
                { provide: KeyStoreService, useValue: keyStore },
                { provide: MessageService, useValue: {} },
                { provide: WebSocketService, useValue: {} },
                { provide: ProfileApiService, useValue: {} },
            ],
        });
        const session = TestBed.inject(SessionService);

        await expectAsync(session.changePassword('old', 'new')).toBeRejected();
        expect(keyStore.completePasswordChange).not.toHaveBeenCalled();

        changePassword.and.returnValue(of({}));
        await session.changePassword('old', 'new');
        expect(keyStore.completePasswordChange).toHaveBeenCalledWith(wrapped as never);
    });
});
