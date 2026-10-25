import { Component, input, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { Sticker, StickerPack, StickerPackSummary } from '../../../core/models/sticker.model';
import { ChatPanelStoreService, ComposerBridge } from '../../../core/services/chat-panel-store.service';
import { StickerApiService } from '../../../core/services/sticker-api.service';
import { ChatInfoComponent } from '../chat-info/chat-info.component';
import { ChatPanelComponent } from './chat-panel.component';

@Component({ selector: 'app-chat-info', template: '<p class="stub-info">info for {{ chatId() }}</p>' })
class StubChatInfoComponent {
    readonly chatId = input.required<string>();
    readonly embedded = input(false);
}

const STICKER: Sticker = {
    id: 's1',
    pack_id: 'pack-a',
    image_url: 'https://files.test/s1.png',
    emoji: '😀',
    position: 0,
};

const PACK: StickerPackSummary = {
    id: 'pack-a',
    owner_id: 'user-1',
    title: 'Cats',
    is_public: false,
    sticker_count: 1,
    cover_image_url: null,
};

const PACK_DETAIL: StickerPack = {
    id: 'pack-a',
    owner_id: 'user-1',
    title: 'Cats',
    is_public: false,
    stickers: [STICKER],
};

function fakeBridge(reason: string | null = null) {
    const unavailableReason = signal<string | null>(reason);
    const bridge = {
        unavailableReason,
        insertEmoji: jasmine.createSpy('insertEmoji').and.returnValue(true),
        sendSticker: jasmine.createSpy('sendSticker').and.returnValue(true),
    };
    return { bridge: bridge as ComposerBridge & typeof bridge, unavailableReason };
}

describe('ChatPanelComponent', () => {
    let fixture: ComponentFixture<ChatPanelComponent>;
    let store: ChatPanelStoreService;
    let stickerApi: jasmine.SpyObj<StickerApiService>;

    function mockViewport(overlay: boolean): void {
        spyOn(window, 'matchMedia').and.returnValue({
            matches: overlay,
            addEventListener: () => {},
            removeEventListener: () => {},
        } as unknown as MediaQueryList);
    }

    async function render(): Promise<HTMLElement> {
        fixture = TestBed.createComponent(ChatPanelComponent);
        fixture.componentRef.setInput('chatId', 'chat-1');
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    function tab(host: HTMLElement, id: string): HTMLButtonElement {
        return host.querySelector<HTMLButtonElement>(`#chat-panel-tab-${id}`)!;
    }

    beforeEach(async () => {
        localStorage.removeItem('chat-panel-open');
        stickerApi = jasmine.createSpyObj<StickerApiService>('StickerApiService', ['getMyPacks', 'getPack']);
        stickerApi.getMyPacks.and.returnValue(of([PACK]));
        stickerApi.getPack.and.returnValue(of(PACK_DETAIL));

        await TestBed.configureTestingModule({
            imports: [ChatPanelComponent],
            providers: [provideRouter([]), { provide: StickerApiService, useValue: stickerApi }],
        })
            .overrideComponent(ChatPanelComponent, {
                remove: { imports: [ChatInfoComponent] },
                add: { imports: [StubChatInfoComponent] },
            })
            .compileComponents();

        store = TestBed.inject(ChatPanelStoreService);
        store.close();
        store.selectTab('profile');
        mockViewport(false);
    });

    afterEach(() => localStorage.removeItem('chat-panel-open'));

    describe('open state (store)', () => {
        it('starts closed, toggles, and remembers the choice', () => {
            expect(store.open()).toBeFalse();

            store.toggle();
            expect(store.open()).toBeTrue();
            expect(localStorage.getItem('chat-panel-open')).toBe('1');

            store.toggle();
            expect(store.open()).toBeFalse();
            expect(localStorage.getItem('chat-panel-open')).toBe('0');
        });

        it('show() opens on the requested tab', () => {
            store.show('emoji');

            expect(store.open()).toBeTrue();
            expect(store.tab()).toBe('emoji');
        });

        it('survives storage that throws', () => {
            spyOn(Storage.prototype, 'setItem').and.throwError('denied');

            expect(() => store.toggle()).not.toThrow();
            expect(store.open()).toBeTrue();
        });

        it('only unregisters the composer that is still registered', () => {
            const first = fakeBridge().bridge;
            const second = fakeBridge().bridge;
            store.registerComposer(first);
            store.registerComposer(second);

            store.unregisterComposer(first);
            expect(store.composer()).toBe(second);

            store.unregisterComposer(second);
            expect(store.composer()).toBeNull();
        });
    });

    describe('tabs', () => {
        it('renders an accessible tablist with Profile selected first', async () => {
            const host = await render();

            expect(host.querySelector('[role="tablist"]')).not.toBeNull();
            expect(tab(host, 'profile').getAttribute('aria-selected')).toBe('true');
            expect(tab(host, 'stickers').getAttribute('aria-selected')).toBe('false');
            expect(tab(host, 'stickers').getAttribute('tabindex')).toBe('-1');
            expect(host.querySelector('.stub-info')?.textContent).toContain('chat-1');
        });

        it('switches tab on click and shows only that tab panel', async () => {
            const host = await render();

            tab(host, 'emoji').click();
            fixture.detectChanges();

            expect(store.tab()).toBe('emoji');
            expect(tab(host, 'emoji').getAttribute('aria-selected')).toBe('true');
            expect(host.querySelector<HTMLElement>('#chat-panel-body-emoji')?.hidden).toBeFalse();
            expect(host.querySelector<HTMLElement>('#chat-panel-body-profile')?.hidden).toBeTrue();
        });

        it('moves between tabs with the arrow keys, wrapping, and with Home/End', async () => {
            const host = await render();

            tab(host, 'profile').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            fixture.detectChanges();
            expect(store.tab()).toBe('stickers');

            tab(host, 'stickers').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
            fixture.detectChanges();
            expect(store.tab()).toBe('emoji');

            tab(host, 'emoji').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            fixture.detectChanges();
            expect(store.tab()).toBe('profile');

            tab(host, 'profile').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
            fixture.detectChanges();
            expect(store.tab()).toBe('emoji');
            expect(document.activeElement).toBe(tab(host, 'emoji'));
        });

        it('does not build the sticker tray (and its fetch) until that tab is opened', async () => {
            const host = await render();
            expect(stickerApi.getMyPacks).not.toHaveBeenCalled();

            tab(host, 'stickers').click();
            fixture.detectChanges();
            await fixture.whenStable();

            expect(stickerApi.getMyPacks).toHaveBeenCalledTimes(1);
        });
    });

    describe('closing', () => {
        it('closes from the close button', async () => {
            store.show('profile');
            const host = await render();

            host.querySelector<HTMLButtonElement>('.close')?.click();

            expect(store.open()).toBeFalse();
        });

        it('closes on Escape when it is a slide-over', async () => {
            store.show('profile');
            (window.matchMedia as jasmine.Spy).and.returnValue({
                matches: true,
                addEventListener: () => {},
                removeEventListener: () => {},
            });
            const host = await render();
            expect(host.classList.contains('is-overlay')).toBeTrue();

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(store.open()).toBeFalse();
        });

        it('closes when the backdrop of a slide-over is clicked', async () => {
            store.show('profile');
            (window.matchMedia as jasmine.Spy).and.returnValue({
                matches: true,
                addEventListener: () => {},
                removeEventListener: () => {},
            });
            const host = await render();

            host.querySelector<HTMLElement>('.backdrop')?.click();

            expect(store.open()).toBeFalse();
        });

        it('ignores Escape when docked, so it cannot swallow the composer’s own Escape', async () => {
            store.show('profile');
            await render();

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(store.open()).toBeTrue();
        });
    });

    describe('emoji tab', () => {
        async function openEmojiTab(): Promise<HTMLElement> {
            store.show('emoji');
            const host = await render();
            return host;
        }

        it('inserts the picked emoji into the composer through the bridge', async () => {
            const { bridge } = fakeBridge();
            store.registerComposer(bridge);
            const host = await openEmojiTab();

            const first = host.querySelector<HTMLButtonElement>('#chat-panel-body-emoji .emoji')!;
            first.click();
            fixture.detectChanges();

            expect(bridge.insertEmoji).toHaveBeenCalledOnceWith(first.getAttribute('aria-label')!);
            expect(host.querySelector('.note')).toBeNull();
        });

        it('is disabled, with the composer’s reason, while the composer refuses (editing)', async () => {
            const { bridge } = fakeBridge('Finish or cancel editing the message first.');
            store.registerComposer(bridge);
            const host = await openEmojiTab();

            const fieldset = host.querySelector<HTMLFieldSetElement>('#chat-panel-body-emoji fieldset')!;
            expect(fieldset.disabled).toBeTrue();
            expect(host.querySelector('#chat-panel-body-emoji .note')?.textContent).toContain('editing');

            host.querySelector<HTMLButtonElement>('#chat-panel-body-emoji .emoji')?.click();
            expect(bridge.insertEmoji).not.toHaveBeenCalled();
        });

        it('re-enables when the composer stops refusing', async () => {
            const { bridge, unavailableReason } = fakeBridge('Finish or cancel editing the message first.');
            store.registerComposer(bridge);
            const host = await openEmojiTab();

            unavailableReason.set(null);
            fixture.detectChanges();

            expect(host.querySelector<HTMLFieldSetElement>('#chat-panel-body-emoji fieldset')?.disabled).toBeFalse();
        });

        it('is disabled when no composer is on screen', async () => {
            const host = await openEmojiTab();

            expect(host.querySelector<HTMLFieldSetElement>('#chat-panel-body-emoji fieldset')?.disabled).toBeTrue();
        });

        it('says so when the composer turns down a pick that raced the guard', async () => {
            const { bridge } = fakeBridge();
            bridge.insertEmoji.and.returnValue(false);
            store.registerComposer(bridge);
            const host = await openEmojiTab();

            host.querySelector<HTMLButtonElement>('#chat-panel-body-emoji .emoji')?.click();
            fixture.detectChanges();

            expect(host.querySelector('#chat-panel-body-emoji .note')?.textContent).toContain('could not accept');
        });
    });

    describe('stickers tab', () => {
        async function openStickerTab(): Promise<HTMLElement> {
            store.show('stickers');
            return render();
        }

        it('sends the picked sticker through the composer bridge', async () => {
            const { bridge } = fakeBridge();
            store.registerComposer(bridge);
            const host = await openStickerTab();

            host.querySelector<HTMLButtonElement>('app-sticker-picker .sticker')?.click();
            fixture.detectChanges();

            expect(bridge.sendSticker).toHaveBeenCalledOnceWith(STICKER);
        });

        it('is disabled while the composer refuses (editing / blocked / read-only)', async () => {
            const { bridge } = fakeBridge('This conversation is read-only.');
            store.registerComposer(bridge);
            const host = await openStickerTab();

            expect(host.querySelector<HTMLFieldSetElement>('#chat-panel-body-stickers fieldset')?.disabled).toBeTrue();
            expect(host.querySelector('#chat-panel-body-stickers .note')?.textContent).toContain('read-only');

            host.querySelector<HTMLButtonElement>('app-sticker-picker .sticker')?.click();
            expect(bridge.sendSticker).not.toHaveBeenCalled();
        });

        it('does not dismiss itself on an outside click, unlike the composer popover', async () => {
            const { bridge } = fakeBridge();
            store.registerComposer(bridge);
            await openStickerTab();
            const closeSpy = jasmine.createSpy('closeRequested');
            fixture.debugElement
                .query((el) => el.name === 'app-sticker-picker')
                .componentInstance.closeRequested.subscribe(closeSpy);

            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

            expect(closeSpy).not.toHaveBeenCalled();
        });
    });
});
