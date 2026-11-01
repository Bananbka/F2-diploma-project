import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, UrlTree } from '@angular/router';

import { ConfirmService } from '../../shared/ui/confirm-dialog/confirm.service';
import { settingsDeepLinkGuard } from './settings.guard';
import { SettingsService, tabFromSegment } from './settings.service';

describe('settings deep links', () => {
    let router: { navigated: boolean; url: string; parseUrl: jasmine.Spy };
    let settings: SettingsService;
    let confirm: jasmine.SpyObj<ConfirmService>;

    function run(data: Record<string, unknown>, params: Record<string, string> = {}) {
        const route = { data, params } as unknown as ActivatedRouteSnapshot;
        return TestBed.runInInjectionContext(() => settingsDeepLinkGuard(route, {} as never));
    }

    beforeEach(() => {
        router = {
            navigated: false,
            url: '/',
            parseUrl: jasmine.createSpy().and.callFake((u: string) => ({ u }) as unknown as UrlTree),
        };
        confirm = jasmine.createSpyObj<ConfirmService>('ConfirmService', ['ask']);
        confirm.ask.and.resolveTo(false);
        TestBed.configureTestingModule({
            providers: [
                { provide: Router, useValue: router },
                { provide: ConfirmService, useValue: confirm },
            ],
        });
        settings = TestBed.inject(SettingsService);
    });

    it('opens the dialog on a cold load and redirects to the chat shell to sit on', () => {
        const result = run({}, { tab: 'security' });
        expect(settings.activeTab()).toBe('security');
        expect(router.parseUrl).toHaveBeenCalledWith('/chats');
        expect(result).toEqual({ u: '/chats' } as unknown as UrlTree);
    });

    it('opens over the current conversation without leaving it when followed from inside the shell', () => {
        router.navigated = true;
        router.url = '/chats/abc';
        expect(run({ tab: 'stickers' })).toBeFalse();
        expect(settings.activeTab()).toBe('stickers');
    });

    it('redirects to the shell when followed from some other page', () => {
        router.navigated = true;
        router.url = '/stickers/discover';
        expect(run({ tab: 'profile' })).not.toBeFalse();
    });

    it('maps the retired page names and unknown tabs', () => {
        expect(tabFromSegment('profile')).toBe('profile');
        expect(tabFromSegment('password')).toBe('security');
        expect(tabFromSegment('security')).toBe('security');
        expect(tabFromSegment('stickers')).toBe('stickers');
        expect(tabFromSegment('privacy')).toBe('privacy');
        expect(tabFromSegment('nonsense')).toBe('profile');
        expect(tabFromSegment(undefined)).toBe('profile');
    });

    it('falls back to Profile for an unknown tab segment', () => {
        run({}, { tab: 'nonsense' });
        expect(settings.activeTab()).toBe('profile');
    });

    it('does not discard unsaved edits when a link asks for another tab while the dialog is open', async () => {
        settings.open('profile');
        settings.registerDirtyCheck(() => true);
        router.navigated = true;
        router.url = '/chats';

        expect(run({ tab: 'stickers' })).toBeFalse();
        await Promise.resolve();
        await Promise.resolve();

        expect(confirm.ask).toHaveBeenCalledTimes(1);
        expect(settings.activeTab()).toBe('profile');
    });
});
