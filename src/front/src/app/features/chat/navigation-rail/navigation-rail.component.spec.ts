import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { UserProfile } from '../../../core/models/chat.model';
import { AuthApiService } from '../../../core/services/auth-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { Folder, FolderApiService } from '../../../core/services/folder-api.service';
import { FolderStoreService } from '../../../core/services/folder-store.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { MessageService } from '../../../core/services/message.service';
import { ProfileApiService } from '../../../core/services/profile-api.service';
import { SessionService } from '../../../core/services/session.service';
import { WebSocketService } from '../../../core/services/websocket.service';
import { SettingsService } from '../../settings/settings.service';
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

const folders = signal<Folder[]>([]);

describe('NavigationRailComponent avatar', () => {
    let fixture: ComponentFixture<NavigationRailComponent>;
    let session: SessionService;
    let authApi: jasmine.SpyObj<AuthApiService>;

    function avatarSrc(): string | null {
        return (fixture.nativeElement as HTMLElement).querySelector('app-avatar img.face')?.getAttribute('src') ?? null;
    }

    beforeEach(async () => {
        folders.set([]);
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
                { provide: ChatStoreService, useValue: { chats: signal([]) } },
                { provide: FolderApiService, useValue: { getFolders: () => of(folders()) } },
            ],
        }).compileComponents();

        session = TestBed.inject(SessionService);
        fixture = TestBed.createComponent(NavigationRailComponent);
        fixture.componentRef.setInput('view', 'all');
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

    describe('views', () => {
        const root = () => fixture.nativeElement as HTMLElement;
        const button = (label: string) =>
            root().querySelector<HTMLButtonElement>(`nav button[aria-label^="${label}"]`)!;

        it('offers the system views and a New folder entry, marking the selected one', async () => {
            await session.restore();
            fixture.detectChanges();

            for (const label of ['All chats', 'Unread', 'Direct', 'Groups', 'Channels', 'New folder']) {
                expect(button(label)).withContext(label).not.toBeNull();
            }
            expect(button('All chats').getAttribute('aria-current')).toBe('page');
            expect(button('Groups').getAttribute('aria-current')).toBeNull();
        });

        it('emits the chosen view, for system views and folders alike', async () => {
            TestBed.inject(FolderStoreService).folders.set([{ id: 'f1', title: 'Work', items: [] }]);
            await session.restore();
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();
            const emitted: string[] = [];
            fixture.componentInstance.viewChange.subscribe((v) => emitted.push(v));

            button('Groups').click();
            button('Folder Work').click();

            expect(emitted).toEqual(['group', 'folder:f1']);
            expect(button('Folder Work').textContent).toContain('W');
        });

        it('opens the folder dialog from New folder', async () => {
            await session.restore();
            fixture.detectChanges();

            button('New folder').click();
            fixture.detectChanges();

            expect(root().querySelector('app-folder-edit-dialog')).not.toBeNull();
        });
    });

    describe('settings entry', () => {
        let settings: SettingsService;

        beforeEach(async () => {
            settings = TestBed.inject(SettingsService);
            await session.restore();
            fixture.detectChanges();
        });

        afterEach(() => settings.close());

        const root = () => fixture.nativeElement as HTMLElement;

        it('has a Settings button that opens the dialog on the Profile tab', () => {
            const button = root().querySelector<HTMLButtonElement>('button[title="Settings"]')!;
            button.focus();
            button.click();

            expect(settings.activeTab()).toBe('profile');
        });

        it('opens Profile and Security from the account menu', () => {
            root().querySelector<HTMLButtonElement>('.account-trigger')!.click();
            fixture.detectChanges();
            const items = [...root().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];

            items.find((b) => b.textContent!.includes('Change password'))!.click();
            expect(settings.activeTab()).toBe('security');
            fixture.detectChanges();
            expect(root().querySelector('[role="menu"]')).toBeNull();
        });
    });
});
