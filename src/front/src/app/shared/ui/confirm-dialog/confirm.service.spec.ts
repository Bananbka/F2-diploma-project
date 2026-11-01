import { TestBed } from '@angular/core/testing';

import { ConfirmService } from './confirm.service';
import { ConfirmDialogHostComponent } from './confirm-dialog-host.component';

describe('ConfirmService and host', () => {
    const request = { title: 'Leave?', message: 'Sure?', confirmLabel: 'Leave', danger: true };

    it('resolves true on confirm and false on cancel', async () => {
        const service = TestBed.inject(ConfirmService);

        const yes = service.ask(request);
        service.answer(true);
        expect(await yes).toBeTrue();

        const no = service.ask(request);
        service.answer(false);
        expect(await no).toBeFalse();
        expect(service.pending()).toBeNull();
    });

    it('cancels the earlier question when a new one is asked', async () => {
        const service = TestBed.inject(ConfirmService);
        const first = service.ask(request);
        void service.ask({ ...request, title: 'Second' });

        expect(await first).toBeFalse();
        expect(service.pending()?.title).toBe('Second');
        service.answer(false);
    });

    it('renders an alert dialog with Cancel focused, and Escape cancels', async () => {
        const fixture = TestBed.createComponent(ConfirmDialogHostComponent);
        const service = TestBed.inject(ConfirmService);
        fixture.detectChanges();

        const answer = service.ask(request);
        fixture.detectChanges();
        fixture.detectChanges();

        const host = fixture.nativeElement as HTMLElement;
        expect(host.querySelector('[role="alertdialog"]')).toBeTruthy();
        expect(document.activeElement?.textContent?.trim()).toBe('Cancel');

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(await answer).toBeFalse();
    });

    it('traps Tab inside the dialog in both directions', async () => {
        const fixture = TestBed.createComponent(ConfirmDialogHostComponent);
        const service = TestBed.inject(ConfirmService);
        fixture.detectChanges();
        void service.ask(request);
        fixture.detectChanges();
        fixture.detectChanges();

        const buttons = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button')];
        const tab = (shiftKey: boolean) =>
            document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
            );

        expect(document.activeElement).toBe(buttons[0]);
        tab(false);
        expect(document.activeElement).toBe(buttons[1]);
        tab(false);
        expect(document.activeElement).toBe(buttons[0]);
        tab(true);
        expect(document.activeElement).toBe(buttons[1]);
        service.answer(false);
    });

    it('swallows Escape so a dialog underneath does not also close', async () => {
        const fixture = TestBed.createComponent(ConfirmDialogHostComponent);
        const service = TestBed.inject(ConfirmService);
        fixture.detectChanges();
        const underneath = jasmine.createSpy('underneath');
        document.addEventListener('keydown', underneath);

        const answer = service.ask(request);
        fixture.detectChanges();
        fixture.detectChanges();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

        expect(await answer).toBeFalse();
        expect(underneath).not.toHaveBeenCalled();
        document.removeEventListener('keydown', underneath);
    });
});
