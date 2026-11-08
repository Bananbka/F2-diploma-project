import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, provideRouter, Router, UrlTree } from '@angular/router';

import { ChatPanelStoreService } from '../../../core/services/chat-panel-store.service';
import { ChatInfoComponent } from '../chat-info/chat-info.component';
import { InfoDialogComponent } from './info-dialog.component';
import { chatInfoDeepLinkGuard, InfoDialogService, safetyDeepLinkGuard } from './info-dialog.service';

describe('InfoDialogService and guards', () => {
    let service: InfoDialogService;
    let panel: ChatPanelStoreService;

    function snapshot(params: Record<string, string>): ActivatedRouteSnapshot {
        return { params, data: {} } as unknown as ActivatedRouteSnapshot;
    }

    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideRouter([])] });
        service = TestBed.inject(InfoDialogService);
        panel = TestBed.inject(ChatPanelStoreService);
    });

    it('opens and closes', () => {
        service.open('c1');
        expect(service.chatId()).toBe('c1');
        service.close();
        expect(service.chatId()).toBeNull();
    });

    it('openSafety lands on the person with the safety number showing, keeping the chat-level state shape', () => {
        service.openSafety('c1', 'u2');
        expect(service.chatId()).toBe('c1');
        expect(panel.infoState('c1')).toEqual({ tab: 'main', memberId: 'u2', safetyOpen: true });
    });

    it('the info guard opens the dialog and sends a cold load to the chat', () => {
        const result = TestBed.runInInjectionContext(() =>
            chatInfoDeepLinkGuard(snapshot({ chatId: 'c9' }), {} as never)
        );
        expect(service.chatId()).toBe('c9');
        expect(result instanceof UrlTree).toBeTrue();
        expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/chats/c9');
    });

    it('the safety guard opens the dialog on that person', () => {
        const result = TestBed.runInInjectionContext(() =>
            safetyDeepLinkGuard(snapshot({ chatId: 'c9', userId: 'u3' }), {} as never)
        );
        expect(service.chatId()).toBe('c9');
        expect(panel.infoState('c9')?.memberId).toBe('u3');
        expect(result instanceof UrlTree).toBeTrue();
    });

    it('stays put when the user is already on that chat', async () => {
        const router = TestBed.inject(Router);
        router.resetConfig([{ path: 'chats/:id', children: [] }]);
        await router.navigateByUrl('/chats/c9');
        const result = TestBed.runInInjectionContext(() =>
            chatInfoDeepLinkGuard(snapshot({ chatId: 'c9' }), {} as never)
        );
        expect(result).toBeFalse();
    });
});

@Component({ selector: 'app-chat-info', template: '<p>info</p>' })
class StubChatInfoComponent {
    readonly chatId = input<string>();
    readonly embedded = input(false);
}

describe('InfoDialogComponent', () => {
    it('embeds the chat info and closes on Escape, the close button and the backdrop', () => {
        TestBed.configureTestingModule({ providers: [provideRouter([])] });
        TestBed.overrideComponent(InfoDialogComponent, {
            remove: { imports: [ChatInfoComponent] },
            add: { imports: [StubChatInfoComponent] },
        });
        const fixture = TestBed.createComponent(InfoDialogComponent);
        fixture.componentRef.setInput('chatId', 'c1');
        let closed = 0;
        fixture.componentInstance.closed.subscribe(() => closed++);
        fixture.detectChanges();
        const root = fixture.nativeElement as HTMLElement;

        const dialog = root.querySelector('[role="dialog"]')!;
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(root.querySelector('app-chat-info')).not.toBeNull();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(closed).toBe(1);
        (root.querySelector('.close') as HTMLButtonElement).click();
        expect(closed).toBe(2);
        (root.querySelector('.backdrop') as HTMLElement).click();
        expect(closed).toBe(3);
        fixture.destroy();
    });
});
