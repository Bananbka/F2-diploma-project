import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { Reply, Trash2 } from 'lucide-angular';

import { ContextMenuDirective, ContextMenuProvider, LONG_PRESS_MS } from './context-menu.directive';
import { ContextMenuEntry } from './context-menu.model';
import { ContextMenuService } from './context-menu.service';
import { ContextMenuHostComponent } from './context-menu-host.component';
import { SUBMENU_CLOSE_DELAY_MS } from './context-menu-panel.component';

@Component({
    selector: 'app-test-host',
    imports: [ContextMenuHostComponent, ContextMenuDirective],
    template: `
        <button
            id="trigger"
            type="button"
            [appContextMenu]="provider()"
        >
            row
        </button>
        <div
            id="field-wrap"
            [appContextMenu]="provider()"
        >
            <input
                id="field"
                type="text"
            />
            <a
                id="link"
                href="#x"
                >link</a
            >
            <span id="text">some text</span>
        </div>
        <button
            id="other"
            type="button"
        >
            other
        </button>
        <app-context-menu-host />
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class TestHostComponent {
    readonly entries = signal<ContextMenuEntry[]>([]);
    readonly provider = signal<ContextMenuProvider>(() => this.entries());
}

describe('context menu system', () => {
    let fixture: ComponentFixture<TestHostComponent>;
    let service: ContextMenuService;
    let root: HTMLElement;
    let log: string[];

    const q = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
    const items = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>('.menu > .item')];
    const labels = (): string[] => items().map((b) => b.querySelector('.item-label')!.textContent!.trim());
    const flush = () => {
        fixture.detectChanges();
        fixture.detectChanges();
    };

    function standardEntries(): ContextMenuEntry[] {
        return [
            { icon: Reply, label: 'Reply', action: () => log.push('reply') },
            { label: 'Mute', children: [{ label: 'One hour', action: () => log.push('1h') }, { label: 'Forever' }] },
            { label: 'Locked', disabled: true, disabledReason: 'Not allowed', action: () => log.push('locked') },
            { separator: true },
            { icon: Trash2, label: 'Delete', danger: true, action: () => log.push('delete') },
        ];
    }

    beforeEach(async () => {
        log = [];
        await TestBed.configureTestingModule({
            imports: [TestHostComponent],
            providers: [provideRouter([])],
        }).compileComponents();
        fixture = TestBed.createComponent(TestHostComponent);
        service = TestBed.inject(ContextMenuService);
        root = fixture.nativeElement as HTMLElement;
        fixture.componentInstance.entries.set(standardEntries());
        fixture.detectChanges();
    });

    afterEach(() => service.close('outside'));

    function rightClick(target: HTMLElement, x = 120, y = 140): MouseEvent {
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y });
        target.dispatchEvent(event);
        flush();
        return event;
    }

    function key(target: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
        const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(event);
        flush();
        return event;
    }

    describe('opening', () => {
        it('opens at the pointer and suppresses the native menu', () => {
            const event = rightClick(q('#trigger'), 200, 150);

            expect(event.defaultPrevented).toBeTrue();
            const menu = q('.menu');
            expect(menu.style.left).toBe('200px');
            expect(menu.style.top).toBe('150px');
            expect(labels()).toEqual(['Reply', 'Mute', 'Locked', 'Delete']);
        });

        it('flips away from the right and bottom edges', () => {
            rightClick(q('#trigger'), window.innerWidth - 4, window.innerHeight - 4);

            const rect = q('.menu').getBoundingClientRect();
            expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
            expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
        });

        it('leaves the native menu alone when there is nothing to show', () => {
            fixture.componentInstance.entries.set([]);

            const event = rightClick(q('#trigger'));

            expect(event.defaultPrevented).toBeFalse();
            expect(service.current()).toBeNull();
        });

        it('keeps the native menu on text fields, links and selected text', () => {
            expect(rightClick(q('#field')).defaultPrevented).toBeFalse();
            expect(rightClick(q('#link')).defaultPrevented).toBeFalse();

            const range = document.createRange();
            range.selectNodeContents(q('#text'));
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
            expect(rightClick(q('#text')).defaultPrevented).toBeFalse();
            window.getSelection()!.removeAllRanges();

            // The same wrapper, without a selection, does get the custom menu.
            expect(rightClick(q('#text')).defaultPrevented).toBeTrue();
        });

        it('opens from the keyboard on the focused host, anchored to it', () => {
            q('#trigger').focus();

            const event = key(q('#trigger'), 'F10', { shiftKey: true });

            expect(event.defaultPrevented).toBeTrue();
            expect(service.current()?.source).toBe('keyboard');
            // Keyboard-opened menus put focus on the first item.
            expect(document.activeElement).toBe(items()[0]);
        });

        it('also opens from the ContextMenu key, but not inside a text field', () => {
            expect(key(q('#field'), 'ContextMenu').defaultPrevented).toBeFalse();
            expect(service.current()).toBeNull();

            q('#trigger').focus();
            key(q('#trigger'), 'ContextMenu');
            expect(service.current()).not.toBeNull();
        });

        it('replaces an open menu rather than stacking a second one', () => {
            rightClick(q('#trigger'));
            rightClick(q('#field-wrap'));

            expect(root.querySelectorAll('.menu').length).toBe(1);
        });

        it('puts focus on the menu itself when opened by pointer', () => {
            rightClick(q('#trigger'));

            expect(document.activeElement).toBe(q('.menu'));
        });
    });

    describe('items', () => {
        it('exposes roles, danger styling, separators and disabled reasons', () => {
            rightClick(q('#trigger'));

            const [reply, mute, locked, del] = items();
            expect(reply.getAttribute('role')).toBe('menuitem');
            expect(mute.getAttribute('aria-haspopup')).toBe('menu');
            expect(locked.getAttribute('aria-disabled')).toBe('true');
            expect(locked.title).toBe('Not allowed');
            expect(del.classList).toContain('is-danger');
            expect(q('.menu [role="separator"]')).toBeTruthy();
        });

        it('uses menuitemcheckbox with aria-checked for toggles', () => {
            fixture.componentInstance.entries.set([
                { label: 'Work', checked: true },
                { label: 'Home', checked: false },
            ]);
            rightClick(q('#trigger'));

            const [work, home] = items();
            expect(work.getAttribute('role')).toBe('menuitemcheckbox');
            expect(work.getAttribute('aria-checked')).toBe('true');
            expect(home.getAttribute('aria-checked')).toBe('false');
        });

        it('runs an action, closes, and returns focus to the trigger', () => {
            q('#trigger').focus();
            rightClick(q('#trigger'));

            items()[0].click();
            flush();

            expect(log).toEqual(['reply']);
            expect(service.current()).toBeNull();
            expect(document.activeElement).toBe(q('#trigger'));
        });

        it('does nothing for a disabled item and stays open', () => {
            rightClick(q('#trigger'));

            items()[2].click();
            flush();

            expect(log).toEqual([]);
            expect(service.current()).not.toBeNull();
        });
    });

    describe('keyboard', () => {
        beforeEach(() => {
            q('#trigger').focus();
            key(q('#trigger'), 'ContextMenu');
        });

        it('moves with arrows, wraps, and jumps with Home and End', () => {
            const menu = q('.menu');
            key(menu, 'ArrowDown');
            expect(document.activeElement).toBe(items()[1]);

            key(menu, 'End');
            expect(document.activeElement).toBe(items()[3]);

            key(menu, 'ArrowDown');
            expect(document.activeElement).toBe(items()[0]);

            key(menu, 'ArrowUp');
            expect(document.activeElement).toBe(items()[3]);

            key(menu, 'Home');
            expect(document.activeElement).toBe(items()[0]);
        });

        it('jumps to an item by its first letter', () => {
            key(q('.menu'), 'd');

            expect(document.activeElement).toBe(items()[3]);
        });

        it('closes on Escape and restores focus to the trigger', () => {
            key(q('.menu'), 'Escape');

            expect(service.current()).toBeNull();
            expect(document.activeElement).toBe(q('#trigger'));
        });

        it('closes on Tab and restores focus to the trigger', () => {
            key(q('.menu'), 'Tab');

            expect(service.current()).toBeNull();
            expect(document.activeElement).toBe(q('#trigger'));
        });
    });

    describe('submenus', () => {
        beforeEach(() => rightClick(q('#trigger')));

        it('opens on hover and closes shortly after another item is hovered', fakeAsync(() => {
            items()[1].dispatchEvent(new MouseEvent('mouseenter'));
            flush();
            expect(q('.menu .menu')).toBeTruthy();

            items()[0].dispatchEvent(new MouseEvent('mouseenter'));
            tick(SUBMENU_CLOSE_DELAY_MS - 1);
            flush();
            expect(q('.menu .menu')).withContext('still open during the grace period').toBeTruthy();

            tick(1);
            flush();
            expect(root.querySelector('.menu .menu')).toBeNull();
        }));

        it('keeps the submenu when the pointer reaches it within the grace period', fakeAsync(() => {
            items()[1].dispatchEvent(new MouseEvent('mouseenter'));
            flush();

            items()[0].dispatchEvent(new MouseEvent('mouseenter'));
            q('.menu .menu').dispatchEvent(new MouseEvent('mouseenter'));
            tick(SUBMENU_CLOSE_DELAY_MS * 2);
            flush();

            expect(q('.menu .menu')).toBeTruthy();
        }));

        it('opens on ArrowRight with focus on its first item, and ArrowLeft goes back', () => {
            items()[1].focus();
            key(q('.menu'), 'ArrowRight');

            const sub = q('.menu .menu');
            expect(sub).toBeTruthy();
            expect(document.activeElement).toBe(sub.querySelector('.item'));

            key(sub, 'ArrowLeft');
            expect(root.querySelector('.menu .menu')).toBeNull();
            expect(document.activeElement).toBe(items()[1]);
            expect(service.current()).not.toBeNull();
        });

        it('closes only the submenu on Escape, then the whole menu on the next', () => {
            items()[1].focus();
            key(q('.menu'), 'ArrowRight');

            key(q('.menu .menu'), 'Escape');
            expect(root.querySelector('.menu .menu')).toBeNull();
            expect(service.current()).not.toBeNull();

            key(q('.menu'), 'Escape');
            expect(service.current()).toBeNull();
        });

        it('opens by click and runs a submenu action, closing everything', () => {
            items()[1].click();
            flush();
            const subItems = [...root.querySelectorAll<HTMLButtonElement>('.menu .menu > .item')];
            expect(subItems.length).toBe(2);

            subItems[0].click();
            flush();

            expect(log).toEqual(['1h']);
            expect(service.current()).toBeNull();
        });
    });

    describe('closing', () => {
        beforeEach(() => {
            q('#trigger').focus();
            rightClick(q('#trigger'));
        });

        it('closes on a pointer press outside, without stealing focus back', () => {
            const other = q<HTMLButtonElement>('#other');
            other.focus();

            other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            flush();

            expect(service.current()).toBeNull();
            expect(document.activeElement).toBe(other);
        });

        it('stays open for a press inside the menu', () => {
            q('.menu').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            flush();

            expect(service.current()).not.toBeNull();
        });

        it('closes when the page or an ancestor of the trigger scrolls', () => {
            document.dispatchEvent(new Event('scroll'));
            flush();
            expect(service.current()).toBeNull();

            rightClick(q('#trigger'));
            root.dispatchEvent(new Event('scroll'));
            flush();
            expect(service.current()).toBeNull();
        });

        it('ignores a scroll that cannot move the trigger', () => {
            q('#other').dispatchEvent(new Event('scroll'));
            flush();

            expect(service.current()).not.toBeNull();
        });

        it('ignores a resize that leaves the width alone (soft keyboard), but not a width change', () => {
            window.dispatchEvent(new Event('resize'));
            flush();
            expect(service.current()).not.toBeNull();

            spyOnProperty(window, 'innerWidth', 'get').and.returnValue(window.innerWidth + 50);
            window.dispatchEvent(new Event('resize'));
            flush();
            expect(service.current()).toBeNull();
        });

        it('closes on navigation', async () => {
            await TestBed.inject(Router)
                .navigateByUrl('/elsewhere')
                .catch(() => undefined);
            flush();

            expect(service.current()).toBeNull();
            // Navigation is not a reason to pull focus back to a row that is going away.
            expect(document.activeElement).not.toBe(q('#trigger'));
        });

        it('releases its document listeners once closed', () => {
            const removedFromDocument = spyOn(document, 'removeEventListener').and.callThrough();
            const removedFromWindow = spyOn(window, 'removeEventListener').and.callThrough();

            service.close('outside');
            flush();

            const documentEvents = removedFromDocument.calls.allArgs().map(([type]) => type);
            expect(documentEvents).toEqual(jasmine.arrayContaining(['pointerdown', 'keydown', 'scroll']));
            expect(removedFromWindow.calls.allArgs().map(([type]) => type)).toContain('resize');
        });
    });

    describe('directive details', () => {
        it('claims aria-haspopup only on the focused host, and only while it has entries', () => {
            const trigger = q('#trigger');
            expect(trigger.hasAttribute('aria-haspopup')).toBeFalse();

            trigger.focus();
            expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

            fixture.componentInstance.entries.set([]);
            trigger.blur();
            trigger.focus();
            expect(trigger.hasAttribute('aria-haspopup')).toBeFalse();
        });

        it('does not reopen when the long press follows a native contextmenu for the same press', fakeAsync(() => {
            const touch = (type: string) =>
                new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: 10, clientY: 10 });
            q('#trigger').dispatchEvent(touch('pointerdown'));
            tick(LONG_PRESS_MS - 20);
            rightClick(q('#trigger'), 10, 10);
            const firstId = service.current()!.id;

            tick(40);

            expect(service.current()!.id).toBe(firstId);
            service.close('outside');
            tick(1000);
        }));

        it('stops swallowing clicks if the finger never produced one', fakeAsync(() => {
            let clicks = 0;
            q('#trigger').addEventListener('click', () => clicks++);
            q('#trigger').dispatchEvent(
                new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 1, clientY: 1 })
            );
            tick(LONG_PRESS_MS);
            service.close('outside');

            tick(1100);
            q('#trigger').click();

            expect(clicks).toBe(1);
        }));
    });

    describe('touch long press', () => {
        const touch = (type: string, x: number, y: number) =>
            new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: x, clientY: y });

        it('opens after the press delay at the finger', fakeAsync(() => {
            q('#trigger').dispatchEvent(touch('pointerdown', 50, 60));
            tick(LONG_PRESS_MS - 1);
            expect(service.current()).toBeNull();

            tick(1);
            expect(service.current()?.anchor).toEqual({ x: 50, y: 60 });
            expect(service.current()?.source).toBe('touch');
            service.close('outside');
            tick(1000);
        }));

        it('is abandoned when the finger moves', fakeAsync(() => {
            q('#trigger').dispatchEvent(touch('pointerdown', 50, 60));
            tick(200);
            q('#trigger').dispatchEvent(touch('pointermove', 50, 90));
            tick(LONG_PRESS_MS);

            expect(service.current()).toBeNull();
        }));

        it('is abandoned when the finger lifts early', fakeAsync(() => {
            q('#trigger').dispatchEvent(touch('pointerdown', 50, 60));
            tick(200);
            q('#trigger').dispatchEvent(touch('pointerup', 50, 60));
            tick(LONG_PRESS_MS);

            expect(service.current()).toBeNull();
        }));

        it('ignores a mouse press and leaves no timer behind', fakeAsync(() => {
            q('#trigger').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
            tick(LONG_PRESS_MS);

            expect(service.current()).toBeNull();
        }));

        it('swallows the click that ends the press, once', fakeAsync(() => {
            let clicks = 0;
            q('#trigger').addEventListener('click', () => clicks++);

            q('#trigger').dispatchEvent(touch('pointerdown', 50, 60));
            tick(LONG_PRESS_MS);
            q('#trigger').click();
            expect(clicks).toBe(0);

            q('#trigger').click();
            expect(clicks).toBe(1);
            service.close('outside');
            tick(1000);
        }));

        it('does not activate an item under the lifting finger straight away', fakeAsync(() => {
            q('#trigger').dispatchEvent(touch('pointerdown', 50, 60));
            tick(LONG_PRESS_MS);
            flush();

            items()[0].click();
            expect(log).toEqual([]);

            tick(500);
            items()[0].click();
            expect(log).toEqual(['reply']);
            tick(1000);
        }));
    });
});
