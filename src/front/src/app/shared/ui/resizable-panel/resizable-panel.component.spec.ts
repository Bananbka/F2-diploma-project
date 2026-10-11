import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ResizablePanelComponent } from './resizable-panel.component';

describe('ResizablePanelComponent', () => {
    let fixture: ComponentFixture<ResizablePanelComponent>;

    function create(storageKey = 'test-panel'): HTMLElement {
        fixture = TestBed.createComponent(ResizablePanelComponent);
        fixture.componentRef.setInput('storageKey', storageKey);
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    function stubHandle(host: HTMLElement): HTMLElement {
        const handle = host.querySelector<HTMLElement>('.handle')!;
        handle.setPointerCapture = jasmine.createSpy('setPointerCapture');
        handle.hasPointerCapture = jasmine.createSpy('hasPointerCapture').and.returnValue(true);
        handle.releasePointerCapture = jasmine.createSpy('releasePointerCapture');
        return handle;
    }

    function startDrag(host: HTMLElement, pointerId = 1): HTMLElement {
        const handle = stubHandle(host);
        handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, pointerId }));
        return handle;
    }

    function drag(host: HTMLElement, deltaX: number, pointerId = 1): void {
        startDrag(host, pointerId);
        document.dispatchEvent(new PointerEvent('pointermove', { clientX: deltaX, pointerId }));
        document.dispatchEvent(new PointerEvent('pointerup', { clientX: deltaX, pointerId }));
    }

    afterEach(() => {
        localStorage.clear();
    });

    beforeEach(async () => {
        localStorage.clear();
        await TestBed.configureTestingModule({ imports: [ResizablePanelComponent] }).compileComponents();
    });

    it('defaults to defaultWidth when nothing is stored', () => {
        create();
        expect(fixture.componentInstance.width()).toBe(320);
    });

    it('uses a stored width within range', () => {
        localStorage.setItem('panel-width:test-panel', '400');
        create();
        expect(fixture.componentInstance.width()).toBe(400);
    });

    it('clamps a stored width outside the configured range', () => {
        localStorage.setItem('panel-width:test-panel', '9999');
        create();
        expect(fixture.componentInstance.width()).toBe(512);
    });

    it('ignores an unparseable stored value and falls back to the default', () => {
        localStorage.setItem('panel-width:test-panel', 'not-a-number');
        create();
        expect(fixture.componentInstance.width()).toBe(320);
    });

    it('updates the width live during a drag and persists the final value', () => {
        const host = create();

        drag(host, 50);

        expect(fixture.componentInstance.width()).toBe(370);
        expect(localStorage.getItem('panel-width:test-panel')).toBe('370');
    });

    it('clamps the width if dragged past the minimum', () => {
        const host = create();

        drag(host, -1000);

        expect(fixture.componentInstance.width()).toBe(256);
        expect(localStorage.getItem('panel-width:test-panel')).toBe('256');
    });

    it('clamps the width if dragged past the maximum', () => {
        const host = create();

        drag(host, 1000);

        expect(fixture.componentInstance.width()).toBe(512);
        expect(localStorage.getItem('panel-width:test-panel')).toBe('512');
    });

    it('restores userSelect and clears dragging state on pointercancel', () => {
        const host = create();
        const previousUserSelect = document.body.style.userSelect;

        startDrag(host);
        expect(fixture.componentInstance.isDragging()).toBe(true);
        expect(document.body.style.userSelect).toBe('none');

        document.dispatchEvent(new PointerEvent('pointercancel', { clientX: 50, pointerId: 1 }));

        expect(fixture.componentInstance.isDragging()).toBe(false);
        expect(document.body.style.userSelect).toBe(previousUserSelect);
    });

    it('restores userSelect if the component is destroyed mid-drag with no pointerup/pointercancel', () => {
        const host = create();
        const previousUserSelect = document.body.style.userSelect;

        startDrag(host);
        expect(document.body.style.userSelect).toBe('none');

        fixture.destroy();

        expect(document.body.style.userSelect).toBe(previousUserSelect);
    });

    it('does not crash when localStorage throws', () => {
        spyOn(localStorage, 'getItem').and.throwError('disabled');
        spyOn(localStorage, 'setItem').and.throwError('disabled');

        const host = create();
        expect(fixture.componentInstance.width()).toBe(320);

        drag(host, 50);
        expect(fixture.componentInstance.width()).toBe(370);
    });

    it('ignores a second pointerdown while a drag is already in progress', () => {
        const host = create();
        const handle = stubHandle(host);

        handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, pointerId: 1 }));
        expect(fixture.componentInstance.isDragging()).toBe(true);
        (handle.setPointerCapture as jasmine.Spy).calls.reset();

        // An overlapping drag (second touch point, or a stray pointerdown before the first
        // pointerup/pointercancel) must be a no-op: no new capture, no new listeners, and the
        // in-progress drag's own state stays untouched.
        handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, pointerId: 2 }));
        expect(handle.setPointerCapture).not.toHaveBeenCalled();

        document.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, pointerId: 1 }));
        document.dispatchEvent(new PointerEvent('pointerup', { clientX: 50, pointerId: 1 }));

        // If the second pointerdown had overwritten dragStartX/dragStartWidth, this would not
        // match the delta computed from the first drag's start (clientX 0, width 320).
        expect(fixture.componentInstance.width()).toBe(370);
        expect(fixture.componentInstance.isDragging()).toBe(false);
    });

    it('hides the handle and drops the inline width when disabled', () => {
        const host = create();
        fixture.componentRef.setInput('disabled', true);
        fixture.detectChanges();

        expect(host.querySelector('.handle')).toBeNull();
        expect((fixture.nativeElement as HTMLElement).style.width).toBe('');
    });
});
