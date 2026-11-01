import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { UserProfile } from '../../../core/models/chat.model';
import { AuthApiService } from '../../../core/services/auth-api.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { MessageService } from '../../../core/services/message.service';
import { ProfileApiService } from '../../../core/services/profile-api.service';
import { SessionService } from '../../../core/services/session.service';
import { WebSocketService } from '../../../core/services/websocket.service';
import { NavigationRailComponent } from './navigation-rail.component';

const AVATAR = 'http://localhost:4200/objects/avatars/me.webp';

/** The shape `GET /profile/me` really returns: the avatar is `avatar_url`, not `avatar`. */
const ME: UserProfile = {
    id: 'u1',
    full_name: 'Ada Lovelace',
    username: 'ada',
    email: 'ada@example.test',
    phone_number: '',
    public_key: '',
    bio: null,
    avatar_url: AVATAR,
    is_active: true,
};

describe('NavigationRailComponent avatar', () => {
    let fixture: ComponentFixture<NavigationRailComponent>;
    let session: SessionService;
    let authApi: jasmine.SpyObj<AuthApiService>;

    function avatarSrc(): string | null {
        return (fixture.nativeElement as HTMLElement).querySelector('app-avatar img.face')?.getAttribute('src') ?? null;
    }

    beforeEach(async () => {
        authApi = jasmine.createSpyObj<AuthApiService>('AuthApiService', ['me']);
        authApi.me.and.returnValue(of(ME));
        const keyStore = jasmine.createSpyObj<KeyStoreService>('KeyStoreService', ['lock']);
        (keyStore as unknown as { isUnlocked: unknown }).isUnlocked = signal(true);

        await TestBed.configureTestingModule({
            imports: [NavigationRailComponent],
            providers: [
                provideRouter([]),
                { provide: AuthApiService, useValue: authApi },
                { provide: KeyStoreService, useValue: keyStore },
                { provide: CryptoApiService, useValue: {} },
                { provide: MessageService, useValue: {} },
                { provide: WebSocketService, useValue: {} },
                { provide: ProfileApiService, useValue: {} },
            ],
        }).compileComponents();

        session = TestBed.inject(SessionService);
        fixture = TestBed.createComponent(NavigationRailComponent);
        fixture.componentRef.setInput('filter', 'all');
    });

    it('shows the avatar from a profile loaded from the API (avatar_url)', async () => {
        await session.restore();
        fixture.detectChanges();

        expect(avatarSrc()).toBe(AVATAR);
    });

    it('still shows it after a simulated full reload (state dropped, profile fetched again)', async () => {
        await session.restore();
        session.user.set(null);
        fixture.detectChanges();
        expect(avatarSrc()).toBeNull();

        await session.restore();
        fixture.detectChanges();

        expect(authApi.me).toHaveBeenCalledTimes(2);
        expect(avatarSrc()).toBe(AVATAR);
    });
});
