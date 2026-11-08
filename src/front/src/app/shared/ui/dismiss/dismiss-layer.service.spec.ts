import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { DismissStackService } from './dismiss-layer.service';
import { DismissOnEscapeDirective } from './dismiss-on-escape.directive';

function escape(target: EventTarget = document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
}

describe('DismissStackService', () => {
    let stack: DismissStackService;

    beforeEach(() => {
        stack = TestBed.inject(DismissStackService);
    });

    it('closes only the topmost layer per press, innermost first', () => {
        const calls: string[] = [];
        const removeOuter = stack.push({ close: () => (calls.push('outer'), removeOuter()) });
        const removeInner = stack.push({ close: () => (calls.push('inner'), removeInner()) });

        escape();
        expect(calls).toEqual(['inner']);
        escape();
        expect(calls).toEqual(['inner', 'outer']);
        expect(stack.depth).toBe(0);
    });

    it('leaves a key that something else already handled alone', () => {
        const close = jasmine.createSpy('close');
        const remove = stack.push({ close });
        document.body.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
        escape();
        expect(close).not.toHaveBeenCalled();
        remove();
    });

    it('stops listening once the last layer is removed', () => {
        const close = jasmine.createSpy('close');
        stack.push({ close })();
        escape();
        expect(close).not.toHaveBeenCalled();
    });
});

@Component({
    imports: [DismissOnEscapeDirective],
    template: `
        @if (open) {
            <div (appDismissOnEscape)="open = false; closes = closes + 1"></div>
        }
    `,
})
class HostComponent {
    open = true;
    closes = 0;
}

describe('DismissOnEscapeDirective', () => {
    it('closes its dialog on Escape wherever focus is, and unregisters when destroyed', () => {
        const fixture = TestBed.createComponent(HostComponent);
        fixture.detectChanges();
        const stack = TestBed.inject(DismissStackService);
        expect(stack.depth).toBe(1);

        escape();
        fixture.detectChanges();
        expect(fixture.componentInstance.closes).toBe(1);
        expect(stack.depth).toBe(0);

        escape();
        expect(fixture.componentInstance.closes).toBe(1);
    });
});
