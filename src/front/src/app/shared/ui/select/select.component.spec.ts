import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SelectComponent, SelectOption } from './select.component';

describe('SelectComponent', () => {
    const options: SelectOption[] = [
        { value: 'none', label: 'Never' },
        { value: '1d', label: 'In 1 day' },
        { value: '7d', label: 'In 7 days' },
    ];
    let fixture: ComponentFixture<SelectComponent>;
    let host: HTMLElement;
    let changes: string[];

    beforeEach(() => {
        fixture = TestBed.createComponent(SelectComponent);
        fixture.componentRef.setInput('options', options);
        fixture.componentRef.setInput('value', 'none');
        fixture.componentRef.setInput('label', 'Expires');
        changes = [];
        fixture.componentInstance.valueChange.subscribe((v) => changes.push(v));
        fixture.detectChanges();
        host = fixture.nativeElement as HTMLElement;
    });

    afterEach(() => fixture.destroy());

    const trigger = () => host.querySelector('.trigger') as HTMLButtonElement;
    const listbox = () => document.body.querySelector('.listbox') as HTMLElement | null;
    const open = () => {
        trigger().click();
        fixture.detectChanges();
    };
    const key = (k: string) => {
        listbox()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        fixture.detectChanges();
    };

    it('shows the selected label and no native select', () => {
        expect(trigger().textContent).toContain('Never');
        expect(host.querySelector('select')).toBeNull();
        expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    });

    it('opens a body-level listbox with option roles and a check on the selected one', () => {
        open();
        expect(listbox()).not.toBeNull();
        expect(trigger().getAttribute('aria-expanded')).toBe('true');
        const items = Array.from(listbox()!.querySelectorAll('[role="option"]'));
        expect(items.length).toBe(3);
        expect(items[0].getAttribute('aria-selected')).toBe('true');
        expect(items[0].querySelector('.check')).not.toBeNull();
        expect(items[1].querySelector('.check')).toBeNull();
    });

    it('picks with a click, emits the value and closes', () => {
        open();
        (listbox()!.querySelectorAll('[role="option"]')[2] as HTMLElement).click();
        fixture.detectChanges();
        expect(changes).toEqual(['7d']);
        expect(listbox()).toBeNull();
    });

    it('moves with the arrow keys, Home and End, and picks with Enter', () => {
        open();
        key('ArrowDown');
        key('ArrowDown');
        key('ArrowDown');
        expect(fixture.componentInstance.active()).toBe(2);
        key('Home');
        expect(fixture.componentInstance.active()).toBe(0);
        key('End');
        expect(fixture.componentInstance.active()).toBe(2);
        key('ArrowUp');
        key('Enter');
        expect(changes).toEqual(['1d']);
    });

    it('picks with Space', () => {
        open();
        key('End');
        key(' ');
        expect(changes).toEqual(['7d']);
    });

    it('jumps by typeahead', () => {
        open();
        key('i');
        key('n');
        expect(fixture.componentInstance.active()).toBe(1);
    });

    it('opens from the trigger with the arrow keys', () => {
        trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        fixture.detectChanges();
        expect(listbox()).not.toBeNull();
    });

    it('Escape closes only the popover and the page never sees it', () => {
        open();
        const reached = jasmine.createSpy('reached');
        document.addEventListener('keydown', reached);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        document.removeEventListener('keydown', reached);
        fixture.detectChanges();
        expect(listbox()).toBeNull();
        expect(reached).not.toHaveBeenCalled();
        expect(changes).toEqual([]);
    });

    it('closes on an outside press but not on one inside', () => {
        open();
        listbox()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        fixture.detectChanges();
        expect(listbox()).not.toBeNull();
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        fixture.detectChanges();
        expect(listbox()).toBeNull();
    });

    it('does not open when disabled', () => {
        fixture.componentRef.setInput('disabled', true);
        fixture.detectChanges();
        trigger().click();
        fixture.detectChanges();
        expect(listbox()).toBeNull();
    });

    it('removes the listbox when destroyed while open', () => {
        open();
        fixture.destroy();
        expect(listbox()).toBeNull();
    });
});
