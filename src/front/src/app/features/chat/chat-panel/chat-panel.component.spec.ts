import { Component, input, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { UserProfile } from '../../../core/models/chat.model';
import { Sticker, StickerPack, StickerPackSummary } from '../../../core/models/sticker.model';
import { ChatPanelStoreService, ComposerBridge } from '../../../core/services/chat-panel-store.service';
import { SessionService } from '../../../core/services/session.service';
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

const STORAGE_KEYS = [
    'chat-panel-open',
    'chat-panel-view',
    'chat-panel-picker-tab',
    'panel-width:chat-panel',
    'picker-recents:u1:emoji',
    'picker-recents:u1:stickers',
];

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
        STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
        stickerApi = jasmine.createSpyObj<StickerApiService>('StickerApiService', ['getMyPacks', 'getPack']);
        stickerApi.getMyPacks.and.returnValue(of([PACK]));
        stickerApi.getPack.and.returnValue(of(PACK_DETAIL));

        await TestBed.configureTestingModule({
            imports: [ChatPanelComponent],
            providers: [
                provideRouter([]),
                { provide: StickerApiService, useValue: stickerApi },
                { provide: SessionService, useValue: { user: signal({ id: 'u1' } as UserProfile) } },
            ],
        })
            .overrideComponent(ChatPanelComponent, {
                remove: { imports: [ChatInfoComponent] },
                add: { imports: [StubChatInfoComponent] },
            })
            .compileComponents();

        store = TestBed.inject(ChatPanelStoreService);
        store.close();
        store.showPicker('emoji');
        store.close();
        mockViewport(false);
    });

    afterEach(() => STORAGE_KEYS.forEach((key) => localStorage.removeItem(key)));

    describe('open state (store)', () => {
        it('starts closed, and each entry point toggles its own view', () => {
            expect(store.open()).toBeFalse();

            store.togglePicker();
            expect(store.open()).toBeTrue();
            expect(store.view()).toBe('picker');
            expect(localStorage.getItem('chat-panel-open')).toBe('1');

            store.togglePicker();
            expect(store.open()).toBeFalse();
            expect(localStorage.getItem('chat-panel-open')).toBe('0');
        });

        it('pressing the other entry point switches the view instead of closing', () => {
            store.togglePicker();

            store.toggleProfile();

            expect(store.open()).toBeTrue();
            expect(store.view()).toBe('profile');

            store.toggleProfile();
            expect(store.open()).toBeFalse();
        });

        it('showPicker() opens on the requested tab and remembers it', () => {
            store.showPicker('stickers');

            expect(store.open()).toBeTrue();
            expect(store.view()).toBe('picker');
            expect(store.pickerTab()).toBe('stickers');
            expect(localStorage.getItem('chat-panel-picker-tab')).toBe('stickers');
        });

        it('survives storage that throws', () => {
            spyOn(Storage.prototype, 'setItem').and.throwError('denied');

            expect(() => store.togglePicker()).not.toThrow();
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

    describe('picker view', () => {
        it('opens on an accessible Emoji | Stickers tablist with Emoji selected', async () => {
            store.showPicker('emoji');
            const host = await render();

            expect(host.querySelector('[role="tablist"]')).not.toBeNull();
            expect(host.querySelectorAll('[role="tab"]').length).toBe(2);
            expect(tab(host, 'emoji').getAttribute('aria-selected')).toBe('true');
            expect(tab(host, 'stickers').getAttribute('aria-selected')).toBe('false');
            expect(tab(host, 'stickers').getAttribute('tabindex')).toBe('-1');
            expect(host.querySelector('.stub-info')).toBeNull();
        });

        it('switches tab on click and shows only that tab panel', async () => {
            store.showPicker('emoji');
            const host = await render();

            tab(host, 'stickers').click();
            fixture.detectChanges();

            expect(store.pickerTab()).toBe('stickers');
            expect(tab(host, 'stickers').getAttribute('aria-selected')).toBe('true');
            expect(host.querySelector<HTMLElement>('#chat-panel-body-stickers')?.hidden).toBeFalse();
            expect(host.querySelector<HTMLElement>('#chat-panel-body-emoji')?.hidden).toBeTrue();
        });

        it('moves between tabs with the arrow keys, wrapping, and with Home/End', async () => {
            store.showPicker('emoji');
            const host = await render();

            tab(host, 'emoji').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            fixture.detectChanges();
            expect(store.pickerTab()).toBe('stickers');

            tab(host, 'stickers').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            fixture.detectChanges();
            expect(store.pickerTab()).toBe('emoji');

            tab(host, 'emoji').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
            fixture.detectChanges();
            expect(store.pickerTab()).toBe('stickers');
            expect(document.activeElement).toBe(tab(host, 'stickers'));

            tab(host, 'stickers').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
            fixture.detectChanges();
            expect(store.pickerTab()).toBe('emoji');
        });

        it('does not build the sticker list (and its fetch) until that tab is opened', async () => {
            store.showPicker('emoji');
            const host = await render();
            expect(stickerApi.getMyPacks).not.toHaveBeenCalled();

            tab(host, 'stickers').click();
            fixture.detectChanges();
            await fixture.whenStable();

            expect(stickerApi.getMyPacks).toHaveBeenCalledTimes(1);
        });
    });

    describe('profile view', () => {
        it('shows chat info and no tablist', async () => {
            store.showProfile();
            const host = await render();

            expect(host.querySelector('.stub-info')?.textContent).toContain('chat-1');
            expect(host.querySelector('[role="tablist"]')).toBeNull();
            expect(host.querySelector('.title')?.textContent).toContain('Chat info');
        });

        it('switching to the picker and back keeps one panel, with the right content each time', async () => {
            store.showProfile();
            const host = await render();

            store.showPicker('emoji');
            fixture.detectChanges();
            expect(host.querySelector<HTMLElement>('#chat-panel-body-profile')?.hidden).toBeTrue();
            expect(host.querySelectorAll('aside').length).toBe(1);

            store.showProfile();
            fixture.detectChanges();
            expect(host.querySelector<HTMLElement>('#chat-panel-body-profile')?.hidden).toBeFalse();
            expect(host.querySelector<HTMLElement>('#chat-panel-body-emoji')?.hidden).toBeTrue();
        });
    });

    describe('closing', () => {
        it('closes from the close button', async () => {
            store.showProfile();
            const host = await render();

            host.querySelector<HTMLButtonElement>('.close')?.click();

            expect(store.open()).toBeFalse();
        });

        it('closes on Escape when it is a slide-over', async () => {
            store.showProfile();
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
            store.showProfile();
            (window.matchMedia as jasmine.Spy).and.returnValue({
                matches: true,
                addEventListener: () => {},
                removeEventListener: () => {},
            });
            const host = await render();

            host.querySelector<HTMLElement>('.backdrop')?.click();

            expect(store.open()).toBeFalse();
        });

        it('ignores Escape when docked, so it cannot swallow the composer own Escape', async () => {
            store.showProfile();
            await render();

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(store.open()).toBeTrue();
        });
    });

    describe('escape handled inside the panel', () => {
        it('does not close the slide-over when a view already used Escape', async () => {
            (window.matchMedia as jasmine.Spy).and.returnValue({
                matches: true,
                addEventListener: () => {},
                removeEventListener: () => {},
            });
            store.showProfile();
            await render();

            const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            handled.preventDefault();
            document.dispatchEvent(handled);
            expect(store.open()).toBeTrue();

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            expect(store.open()).toBeFalse();
        });
    });

    describe('resizing', () => {
        it('has a keyboard-accessible resize separator on the left edge when docked', async () => {
            store.showProfile();
            const host = await render();

            const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
            expect(handle).not.toBeNull();
            expect(handle.getAttribute('aria-valuemin')).toBe('288');
            expect(handle.getAttribute('aria-valuemax')).toBe('576');
            expect(handle.getAttribute('aria-valuenow')).toBe('352');

            handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
            fixture.detectChanges();

            expect(handle.getAttribute('aria-valuenow')).toBe('368');
            expect(localStorage.getItem('panel-width:chat-panel')).toBe('368');
        });

        const VIEWS: { name: string; show: () => void }[] = [
            { name: 'profile', show: () => store.showProfile() },
            { name: 'emoji', show: () => store.showPicker('emoji') },
            { name: 'stickers', show: () => store.showPicker('stickers') },
        ];

        for (const view of VIEWS) {
            it(`keeps the separator present, on top and keyboard-resizable in the ${view.name} view`, async () => {
                view.show();
                const host = await render();
                (fixture.nativeElement as HTMLElement).style.height = '600px'; // a realistic column height

                const handles = host.querySelectorAll<HTMLElement>('[role="separator"]');
                expect(handles.length).toBe(1);
                const handle = handles[0];

                // Nothing from the view's content may sit over the grab strip, or a drag never starts.
                const rect = handle.getBoundingClientRect();
                const misses: string[] = [];
                for (const y of [4, 40, 120, 300, 500]) {
                    // Only points inside the visible viewport can be hit-tested.
                    if (rect.top + y >= window.innerHeight || rect.height <= y) {
                        continue;
                    }
                    const probe = document.elementFromPoint(rect.left + rect.width / 2, rect.top + y);
                    if (probe !== handle) {
                        misses.push(`${y}:${probe?.tagName}.${probe?.className}`);
                    }
                }
                expect(misses).toEqual([]);
                // The host follows the separator in this view, both ways: nothing in the view's content
                // may hold the panel wider than the separator asks.
                const rp = host.querySelector<HTMLElement>('app-resizable-panel')!;
                const widths: number[] = [];
                for (const key of ['Home', 'End', 'Home']) {
                    handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
                    fixture.detectChanges();
                    widths.push(rp.offsetWidth);
                }
                expect(widths).toEqual([288, 576, 288]);

                handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
                fixture.detectChanges();
                expect(handle.getAttribute('aria-valuenow')).toBe('304');
            });
        }

        it('restores the stored width', async () => {
            localStorage.setItem('panel-width:chat-panel', '500');
            store.showProfile();
            const host = await render();

            expect(host.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')).toBe('500');
        });

        it('has no resize handle as a slide-over, which keeps a fixed width', async () => {
            store.showProfile();
            (window.matchMedia as jasmine.Spy).and.returnValue({
                matches: true,
                addEventListener: () => {},
                removeEventListener: () => {},
            });
            const host = await render();

            expect(host.querySelector('[role="separator"]')).toBeNull();
        });
    });

    describe('emoji tab', () => {
        async function openEmojiTab(): Promise<HTMLElement> {
            store.showPicker('emoji');
            return render();
        }

        it('inserts the picked emoji into the composer through the bridge', async () => {
            const { bridge } = fakeBridge();
            store.registerComposer(bridge);
            const host = await openEmojiTab();

            const first = host.querySelector<HTMLButtonElement>('#chat-panel-body-emoji .scroll .emoji')!;
            first.click();
            fixture.detectChanges();

            expect(bridge.insertEmoji).toHaveBeenCalledOnceWith(first.querySelector('img')!.alt);
            expect(host.querySelector('.note')).toBeNull();
        });

        it('remembers picked emoji per user and lists them under Recently used', async () => {
            const { bridge } = fakeBridge();
            store.registerComposer(bridge);
            const host = await openEmojiTab();

            const first = host.querySelector<HTMLButtonElement>('#chat-panel-body-emoji .scroll .emoji')!;
            const emoji = first.querySelector('img')!.alt;
            first.click();
            fixture.detectChanges();

            expect(JSON.parse(localStorage.getItem('picker-recents:u1:emoji')!)).toEqual([emoji]);
            const recent = host.querySelectorAll('#chat-panel-body-emoji section[data-section="recent"] .emoji');
            expect(recent.length).toBe(1);
            expect(recent[0].getAttribute('aria-label')).toBe(emoji);
        });

        it('does not record a recent for a pick the composer refused', async () => {
            const { bridge } = fakeBridge();
            bridge.insertEmoji.and.returnValue(false);
            store.registerComposer(bridge);
            const host = await openEmojiTab();

            host.querySelector<HTMLButtonElement>('#chat-panel-body-emoji .scroll .emoji')?.click();
            fixture.detectChanges();

            expect(localStorage.getItem('picker-recents:u1:emoji')).toBeNull();
            expect(host.querySelector('#chat-panel-body-emoji .note')?.textContent).toContain('could not accept');
        });

        it('is disabled, with the composer reason, while the composer refuses (editing)', async () => {
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
    });

    describe('stickers tab', () => {
        async function openStickerTab(): Promise<HTMLElement> {
            store.showPicker('stickers');
            return render();
        }

        it('sends the picked sticker through the composer bridge and remembers it', async () => {
            const { bridge } = fakeBridge();
            store.registerComposer(bridge);
            const host = await openStickerTab();

            host.querySelector<HTMLButtonElement>('app-sticker-picker .sticker')?.click();
            fixture.detectChanges();

            expect(bridge.sendSticker).toHaveBeenCalledOnceWith(STICKER);
            expect(JSON.parse(localStorage.getItem('picker-recents:u1:stickers')!)).toEqual(['s1']);
            expect(host.querySelector('section[data-section="recent"]')).not.toBeNull();
        });

        it('says so, without crashing or recording a recent, when the composer turns a sticker down', async () => {
            const { bridge } = fakeBridge();
            bridge.sendSticker.and.returnValue(false);
            store.registerComposer(bridge);
            const host = await openStickerTab();

            host.querySelector<HTMLButtonElement>('app-sticker-picker .sticker')?.click();
            fixture.detectChanges();

            expect(host.querySelector('#chat-panel-body-stickers .note')?.textContent).toContain('could not accept');
            expect(localStorage.getItem('picker-recents:u1:stickers')).toBeNull();
        });

        it('is disabled while the composer refuses (editing / blocked / read-only)', async () => {
            const { bridge } = fakeBridge('This conversation is read-only.');
            store.registerComposer(bridge);
            const host = await openStickerTab();

            expect(host.querySelector<HTMLFieldSetElement>('#chat-panel-body-stickers fieldset')?.disabled).toBeTrue();
            expect(host.querySelector('#chat-panel-body-stickers .note')?.textContent).toContain('read-only');

            host.querySelector<HTMLButtonElement>('app-sticker-picker .sticker')?.click();
            expect(bridge.sendSticker).not.toHaveBeenCalled();
            expect(localStorage.getItem('picker-recents:u1:stickers')).toBeNull();
        });
    });
});
