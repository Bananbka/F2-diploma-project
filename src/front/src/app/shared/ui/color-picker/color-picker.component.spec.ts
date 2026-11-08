import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ColorPickerComponent } from './color-picker.component';

describe('ColorPickerComponent', () => {
    let fixture: ComponentFixture<ColorPickerComponent>;
    let host: HTMLElement;
    let changes: string[];
    let cleared: number;

    beforeEach(() => {
        fixture = TestBed.createComponent(ColorPickerComponent);
        fixture.componentRef.setInput('label', 'Test colour');
        fixture.componentRef.setInput('color', '#ff0000');
        fixture.componentRef.setInput('swatches', ['#3b82f6']);
        changes = [];
        cleared = 0;
        fixture.componentInstance.colorChange.subscribe((c) => changes.push(c));
        fixture.componentInstance.cleared.subscribe(() => cleared++);
        fixture.detectChanges();
        host = fixture.nativeElement as HTMLElement;
    });

    afterEach(() => {
        fixture.destroy();
    });

    const popover = () => document.body.querySelector('.popover') as HTMLElement | null;
    const open = () => {
        (host.querySelector('.trigger') as HTMLButtonElement).click();
        fixture.detectChanges();
    };

    it('renders no native colour input and opens a body-level popover', () => {
        expect(host.querySelector('input[type="color"]')).toBeNull();
        expect(popover()).toBeNull();
        open();
        expect(popover()).not.toBeNull();
        expect(popover()!.querySelector('input[type="color"]')).toBeNull();
    });

    it('moves the colour with arrow keys and emits hex', () => {
        open();
        const square = popover()!.querySelector('.square') as HTMLElement;
        square.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(changes.length).toBe(1);
        expect(changes[0]).toMatch(/^#[0-9a-f]{6}$/);
        const hue = popover()!.querySelector('.hue') as HTMLElement;
        hue.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, shiftKey: true }));
        expect(changes.length).toBe(2);
    });

    it('accepts hex with or without # and ignores invalid text', () => {
        open();
        const input = popover()!.querySelector('.hex-input') as HTMLInputElement;
        input.value = '00ff00';
        input.dispatchEvent(new Event('input'));
        expect(changes).toEqual(['#00ff00']);
        input.value = 'zzz';
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        expect(changes.length).toBe(1);
        expect(input.getAttribute('aria-invalid')).toBe('true');
    });

    it('Escape closes only the popover and does not reach the document', () => {
        open();
        const reached = jasmine.createSpy('reached');
        document.addEventListener('keydown', reached);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        document.removeEventListener('keydown', reached);
        fixture.detectChanges();
        expect(popover()).toBeNull();
        expect(reached).not.toHaveBeenCalled();
    });

    it('closes on an outside press but not on one inside', () => {
        open();
        popover()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        fixture.detectChanges();
        expect(popover()).not.toBeNull();
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        fixture.detectChanges();
        expect(popover()).toBeNull();
    });

    it('offers presets and a Default action', () => {
        open();
        (popover()!.querySelector('.preset') as HTMLButtonElement).click();
        expect(changes).toEqual(['#3b82f6']);
        (popover()!.querySelector('.default') as HTMLButtonElement).click();
        fixture.detectChanges();
        expect(cleared).toBe(1);
        expect(popover()).toBeNull();
    });

    it('removes the popover when destroyed while open', () => {
        open();
        fixture.destroy();
        expect(popover()).toBeNull();
    });
});
