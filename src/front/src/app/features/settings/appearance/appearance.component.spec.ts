import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Appearance, DEFAULT_APPEARANCE } from '../../../core/models/appearance.model';
import { AppearanceStore } from '../../../core/services/appearance-store.service';
import { BackgroundImageService } from '../../../core/services/background-image.service';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';
import { AppearanceComponent } from './appearance.component';

describe('AppearanceComponent', () => {
    let fixture: ComponentFixture<AppearanceComponent>;
    let root: HTMLElement;
    let store: { value: ReturnType<typeof signal<Appearance>>; update: jasmine.Spy; reset: jasmine.Spy };
    let confirm: jasmine.SpyObj<ConfirmService>;

    beforeEach(() => {
        store = {
            value: signal<Appearance>(DEFAULT_APPEARANCE),
            update: jasmine.createSpy('update'),
            reset: jasmine.createSpy('reset').and.resolveTo(),
        };
        confirm = jasmine.createSpyObj<ConfirmService>('ConfirmService', ['ask']);
        confirm.ask.and.resolveTo(true);

        TestBed.configureTestingModule({
            imports: [AppearanceComponent],
            providers: [
                { provide: AppearanceStore, useValue: store },
                { provide: ConfirmService, useValue: confirm },
                {
                    provide: BackgroundImageService,
                    useValue: { colorFor: () => Promise.resolve(null), load: () => Promise.resolve(null) },
                },
            ],
        });
        fixture = TestBed.createComponent(AppearanceComponent);
        root = fixture.nativeElement as HTMLElement;
        fixture.detectChanges();
    });

    it('updates the font size from the slider and the stepper', () => {
        const slider = root.querySelector<HTMLInputElement>('#appearance-size')!;
        slider.value = '18';
        slider.dispatchEvent(new Event('input'));
        expect(store.update).toHaveBeenCalledWith({ font_size: 18 });

        root.querySelector<HTMLButtonElement>('button[aria-label="Increase text size"]')!.click();
        expect(store.update).toHaveBeenCalledWith({ font_size: 16 });
    });

    it('updates the font family', () => {
        const select = root.querySelector<HTMLSelectElement>('#appearance-font')!;
        select.value = 'mono';
        select.dispatchEvent(new Event('change'));
        expect(store.update).toHaveBeenCalledWith({ font_family: 'mono' });
    });

    it('sets a bubble colour from a swatch and clears it with Default', () => {
        root.querySelector<HTMLButtonElement>('button[aria-label="Your bubble colour #3b82f6"]')!.click();
        expect(store.update).toHaveBeenCalledWith({ own_bubble_color: '#3b82f6' });

        store.value.set({ ...DEFAULT_APPEARANCE, own_bubble_color: '#3b82f6' });
        fixture.detectChanges();
        root.querySelector<HTMLButtonElement>('.link:not([disabled])')!.click();
        expect(store.update).toHaveBeenCalledWith({ own_bubble_color: null });
    });

    it('selects a gradient background', () => {
        root.querySelector<HTMLButtonElement>('button[aria-label="Gradient ocean"]')!.click();
        expect(store.update).toHaveBeenCalledWith({
            background: { kind: 'gradient', color: null, gradient: 'ocean' },
        });
    });

    it('reflects the draft in the preview', () => {
        store.value.set({ ...DEFAULT_APPEARANCE, own_bubble_color: '#ffff00' });
        fixture.detectChanges();
        const preview = root.querySelector<HTMLElement>('.preview')!;
        expect(preview.style.getPropertyValue('--bubble-own-bg')).toBe('#ffff00');
    });

    it('resets only after confirmation', async () => {
        confirm.ask.and.resolveTo(false);
        await fixture.componentInstance.reset();
        expect(store.reset).not.toHaveBeenCalled();

        confirm.ask.and.resolveTo(true);
        await fixture.componentInstance.reset();
        expect(store.reset).toHaveBeenCalled();
    });

    it('updates the message shape from the slider and the stepper', () => {
        const slider = root.querySelector<HTMLInputElement>('#appearance-radius')!;
        slider.value = '8';
        slider.dispatchEvent(new Event('input'));
        expect(store.update).toHaveBeenCalledWith({ bubble_radius: 8 });
        root.querySelector<HTMLButtonElement>('button[aria-label="More rounded"]')!.click();
        expect(store.update).toHaveBeenCalledWith({ bubble_radius: 20 });
    });

    describe('background image tuning', () => {
        const image = {
            fit: 'cover',
            position_x: 50,
            position_y: 50,
            zoom: 100,
            dim: 0,
            blur: 0,
            version: 'v1',
        } as const;

        beforeEach(() => {
            store.value.set({
                ...DEFAULT_APPEARANCE,
                background_image_version: 'v1',
                background: { kind: 'image', color: null, gradient: null, image },
            });
            fixture.detectChanges();
        });

        it('shows the tuning controls only for an image background and emits fit changes', () => {
            const radios = root.querySelectorAll<HTMLButtonElement>('.fit-option');
            expect(radios.length).toBe(3);
            radios[2].click();
            expect(store.update).toHaveBeenCalledWith({
                background: jasmine.objectContaining({ kind: 'image', image: { ...image, fit: 'tile' } }),
            });
        });

        it('clamps and emits the sliders', () => {
            const dim = root.querySelector<HTMLInputElement>('#appearance-image-dim')!;
            dim.value = '80';
            dim.dispatchEvent(new Event('input'));
            expect(store.update).toHaveBeenCalledWith({
                background: jasmine.objectContaining({ image: { ...image, dim: 80 } }),
            });
            const zoom = root.querySelector<HTMLInputElement>('#appearance-image-zoom')!;
            zoom.value = '250';
            zoom.dispatchEvent(new Event('input'));
            expect(store.update).toHaveBeenCalledWith({
                background: jasmine.objectContaining({ image: { ...image, zoom: 250 } }),
            });
        });

        it('confirms before removing the image', async () => {
            const remove = jasmine.createSpy('removeBackgroundImage').and.resolveTo(true);
            (store as unknown as { removeBackgroundImage: jasmine.Spy }).removeBackgroundImage = remove;
            await fixture.componentInstance.removeImage();
            expect(confirm.ask).toHaveBeenCalled();
            expect(remove).toHaveBeenCalled();
        });

        it('shows the upload error', async () => {
            (store as unknown as { uploadBackgroundImage: jasmine.Spy }).uploadBackgroundImage = jasmine
                .createSpy('upload')
                .and.resolveTo({ ok: false, message: 'Too big.' });
            await fixture.componentInstance.upload(new File([], 'x.png', { type: 'image/png' }));
            fixture.detectChanges();
            expect(root.querySelector('.image-error')?.textContent).toContain('Too big.');
        });
    });
});
