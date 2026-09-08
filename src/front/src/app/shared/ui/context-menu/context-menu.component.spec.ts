import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Reply, Trash2 } from 'lucide-angular';

import { ContextMenuComponent, ContextMenuItem } from './context-menu.component';

describe('ContextMenuComponent', () => {
    let fixture: ComponentFixture<ContextMenuComponent>;
    let replied: number;
    let items: ContextMenuItem[];

    beforeEach(async () => {
        replied = 0;
        items = [
            { icon: Reply, label: 'Reply', action: () => (replied += 1) },
            { icon: Trash2, label: 'Delete', danger: true, action: () => undefined },
        ];

        await TestBed.configureTestingModule({ imports: [ContextMenuComponent] }).compileComponents();
        fixture = TestBed.createComponent(ContextMenuComponent);
    });

    function open(x = 100, y = 100): HTMLElement {
        fixture.componentRef.setInput('items', items);
        fixture.componentRef.setInput('anchor', { x, y });
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    /**
     * The regression this file exists for. An earlier version read the required `anchor` input in the
     * constructor, which throws NG0950 before the component renders — so neither right-click nor the
     * overflow button appeared to do anything at all.
     */
    it('renders its items', () => {
        const host = open();

        const labels = [...host.querySelectorAll('.item-label')].map((node) => node.textContent?.trim());
        expect(labels).toEqual(['Reply', 'Delete']);
    });

    it('positions itself at the anchor', () => {
        const host = open(240, 360);
        const menu = host.querySelector<HTMLElement>('.menu');

        expect(menu?.style.left).toBe('240px');
        expect(menu?.style.top).toBe('360px');
    });

    /** Opened near an edge, it must come back on screen rather than run off it. */
    it('clamps back inside the viewport', async () => {
        open(window.innerWidth + 500, window.innerHeight + 500);
        await fixture.whenStable();
        fixture.detectChanges();

        expect(fixture.componentInstance.left()).toBeLessThan(window.innerWidth);
        expect(fixture.componentInstance.top()).toBeLessThan(window.innerHeight);
    });

    it('runs the action and then closes', () => {
        const host = open();
        let closed = false;
        fixture.componentInstance.closed.subscribe(() => (closed = true));

        host.querySelectorAll<HTMLButtonElement>('.item')[0].click();

        expect(replied).toBe(1);
        expect(closed).toBeTrue();
    });

    it('marks a destructive item so it is not chosen by muscle memory', () => {
        const host = open();
        expect(host.querySelectorAll('.item')[1].classList).toContain('is-danger');
    });

    it('closes on Escape', () => {
        open();
        let closed = false;
        fixture.componentInstance.closed.subscribe(() => (closed = true));

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(closed).toBeTrue();
    });

    it('closes when something outside it is pressed', () => {
        open();
        let closed = false;
        fixture.componentInstance.closed.subscribe(() => (closed = true));

        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(closed).toBeTrue();
    });

    it('stays open when pressed inside itself', () => {
        const host = open();
        let closed = false;
        fixture.componentInstance.closed.subscribe(() => (closed = true));

        host.querySelector('.menu')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(closed).toBeFalse();
    });
});
