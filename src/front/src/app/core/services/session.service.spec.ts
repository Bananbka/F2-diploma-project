import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

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
