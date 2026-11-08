import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EmojiButtonComponent, placePopover } from './emoji-button.component';

@Component({
    imports: [EmojiButtonComponent],
    template: `
        <div
            class="dialog"
            (keydown)="dialogKeys = dialogKeys + 1"
        >
            <input
                #field
                id="f"
            />
            <app-emoji-button [target]="field" />
        </div>
    `,
})
class HostComponent {
    dialogKeys = 0;
}

describe('placePopover with a boundary', () => {
    const size = { width: 200, height: 100 };
    const viewport = { width: 1000, height: 800 };
    const pane = { left: 300, top: 50, right: 900, bottom: 600 };

    it('keeps a popover that would overhang the left edge inside the pane', () => {
        const p = placePopover({ top: 200, bottom: 230, right: 340 }, size, viewport, pane);
        expect(p.left).toBe(308);
    });

    it('keeps it inside the right edge too', () => {
        const p = placePopover({ top: 200, bottom: 230, right: 990 }, size, viewport, pane);
        expect(p.left).toBe(900 - 200 - 8);
    });

    it('flips above when the pane, not the window, runs out of room below', () => {
        const p = placePopover({ top: 540, bottom: 570, right: 600 }, size, viewport, pane);
        expect(p.top).toBe(540 - 4 - 100);
    });

    it('clamps vertically to the pane', () => {
        const p = placePopover({ top: 60, bottom: 90, right: 600 }, { width: 200, height: 700 }, viewport, pane);
        expect(p.top).toBeGreaterThanOrEqual(58);
        expect(p.top).toBeLessThanOrEqual(600 - 700 - 8 > 58 ? 600 : 58);
    });

    it('behaves as before without a boundary', () => {
        expect(placePopover({ top: 100, bottom: 130, right: 500 }, size, viewport)).toEqual(
            placePopover({ top: 100, bottom: 130, right: 500 }, size, viewport, {
                left: 0,
                top: 0,
                right: 1000,
                bottom: 800,
            })
        );
    });
});

describe('placePopover', () => {
    const size = { width: 288, height: 288 };
    const viewport = { width: 1000, height: 800 };

    it('opens below the anchor, right edges aligned', () => {
        const p = placePopover({ top: 100, bottom: 130, right: 500 }, size, viewport);
        expect(p).toEqual({ left: 212, top: 134 });
    });

    it('flips above when there is no room below', () => {
        const p = placePopover({ top: 700, bottom: 730, right: 500 }, size, viewport);
        expect(p.top).toBe(700 - 4 - 288);
    });

    it('clamps into the viewport', () => {
        const p = placePopover({ top: 100, bottom: 130, right: 20 }, size, viewport);
        expect(p.left).toBe(8);
    });
});

describe('EmojiButtonComponent', () => {
    let fixture: ComponentFixture<HostComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
        fixture = TestBed.createComponent(HostComponent);
        fixture.detectChanges();
        fixture.nativeElement.querySelector('.emoji-trigger').click();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
    });

    afterEach(() => fixture.destroy());

    it('renders the popover in the body, fixed and above the dialog layer', () => {
        const picker = document.body.querySelector<HTMLElement>(':scope > app-emoji-picker');
        expect(picker).not.toBeNull();
        expect(picker!.style.position).toBe('fixed');
        expect(Number(picker!.style.zIndex)).toBeGreaterThan(71);
        expect(fixture.nativeElement.querySelector('app-emoji-picker')).toBeNull();
    });

    it('closes on Escape without the event reaching the surrounding dialog, and removes the node', async () => {
        const field = fixture.nativeElement.querySelector('#f') as HTMLInputElement;
        field.focus();
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        fixture.detectChanges();
        await fixture.whenStable();

        expect(fixture.componentInstance.dialogKeys).toBe(0);
        expect(document.body.querySelector('app-emoji-picker')).toBeNull();
    });

    it('closes on an outside click', () => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        fixture.detectChanges();
        expect(document.body.querySelector('app-emoji-picker')).toBeNull();
    });
});
