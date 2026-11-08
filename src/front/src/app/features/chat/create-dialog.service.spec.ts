import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, provideRouter, Router, RouterStateSnapshot } from '@angular/router';

import { createDialogDeepLinkGuard, CreateDialogService } from './create-dialog.service';

describe('CreateDialogService', () => {
    beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter([])] }));

    it('opens and closes', () => {
        const service = TestBed.inject(CreateDialogService);
        service.show('channel');
        expect(service.open()).toBe('channel');
        service.close();
        expect(service.open()).toBeNull();
    });

    function run(kind: string) {
        const route = { data: { kind } } as unknown as ActivatedRouteSnapshot;
        return TestBed.runInInjectionContext(() => createDialogDeepLinkGuard(route, {} as RouterStateSnapshot));
    }

    it('a cold deep link opens the dialog and redirects to the chat shell', () => {
        const result = run('group');
        expect(TestBed.inject(CreateDialogService).open()).toBe('group');
        expect(result instanceof Object && 'toString' in (result as object)).toBeTrue();
        expect(String(result)).toBe('/chats');
    });

    it('an in-app navigation over the shell is cancelled so the conversation stays', () => {
        const router = TestBed.inject(Router);
        router.navigated = true;
        spyOnProperty(router, 'url', 'get').and.returnValue('/chats/abc');
        expect(run('channel')).toBeFalse();
        expect(TestBed.inject(CreateDialogService).open()).toBe('channel');
    });
});
