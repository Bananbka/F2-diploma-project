import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Appearance, DEFAULT_APPEARANCE } from '../../../../core/models/appearance.model';
import { AppearanceStore } from '../../../../core/services/appearance-store.service';
import { BackgroundImageService } from '../../../../core/services/background-image.service';
import { ConfirmService } from '../../../../shared/ui/confirm-dialog/confirm.service';
import { BackgroundEditorComponent } from './background-editor.component';

describe('BackgroundEditorComponent', () => {
    const image = { fit: 'cover', position_x: 50, position_y: 50, zoom: 100, dim: 0, blur: 0, version: 'v1' } as const;
    let fixture: ComponentFixture<BackgroundEditorComponent>;
    let root: HTMLElement;
    let store: {
        value: ReturnType<typeof signal<Appearance>>;
        update: jasmine.Spy;
        removeBackgroundImage: jasmine.Spy;
        uploadBackgroundImage: jasmine.Spy;
    };
    let confirm: jasmine.SpyObj<ConfirmService>;
    let closed: number;

    beforeEach(() => {
        store = {
            value: signal<Appearance>({
                ...DEFAULT_APPEARANCE,
                background_image_version: 'v1',
                background: { kind: 'image', color: null, gradient: null, image },
            }),
            update: jasmine.createSpy('update'),
            removeBackgroundImage: jasmine.createSpy('remove').and.resolveTo(true),
            uploadBackgroundImage: jasmine.createSpy('upload').and.resolveTo({ ok: true }),
        };
        confirm = jasmine.createSpyObj<ConfirmService>('ConfirmService', ['ask']);
        confirm.ask.and.resolveTo(true);
        TestBed.configureTestingModule({
            providers: [
                { provide: AppearanceStore, useValue: store },
                { provide: ConfirmService, useValue: confirm },
                {
                    provide: BackgroundImageService,
                    useValue: { colorFor: () => Promise.resolve(null), load: () => Promise.resolve(null) },
                },
            ],
        });
        fixture = TestBed.createComponent(BackgroundEditorComponent);
        closed = 0;
        fixture.componentInstance.closed.subscribe(() => closed++);
        fixture.detectChanges();
        root = fixture.nativeElement as HTMLElement;
    });

    afterEach(() => fixture.destroy());

    const slider = (key: string) => root.querySelector<HTMLInputElement>(`#bg-edit-${key}`)!;
    const input = (el: HTMLInputElement, value: string) => {
        el.value = value;
        el.dispatchEvent(new Event('input'));
        fixture.detectChanges();
    };

    it('edits a local draft: nothing is committed until Apply', () => {
        input(slider('zoom'), '250');
        root.querySelectorAll<HTMLButtonElement>('.fit-option')[2].click();
        fixture.detectChanges();
        expect(fixture.componentInstance.draft()).toEqual({ ...image, zoom: 250, fit: 'tile' });
        expect(store.update).not.toHaveBeenCalled();
    });

    it('Apply commits the draft through the store once and closes', () => {
        input(slider('dim'), '40');
        root.querySelector<HTMLButtonElement>('.btn.is-primary')!.click();
        expect(store.update).toHaveBeenCalledTimes(1);
        expect(store.update).toHaveBeenCalledWith({
            background: { kind: 'image', color: null, gradient: null, image: { ...image, dim: 40 } },
        });
        expect(closed).toBe(1);
    });

    it('Cancel discards the draft', () => {
        input(slider('blur'), '12');
        root.querySelector<HTMLButtonElement>('.foot .btn:not(.is-primary)')!.click();
        expect(store.update).not.toHaveBeenCalled();
        expect(closed).toBe(1);
    });

    it('clamps sliders and resets tuning without touching the picture version', () => {
        input(slider('dim'), '500');
        expect(fixture.componentInstance.draft().dim).toBe(80);
        fixture.componentInstance.resetTuning();
        expect(fixture.componentInstance.draft()).toEqual({ ...image });
    });

    it('dragging the picture inside the frame updates the position, and ends cleanly', () => {
        const frame = root.querySelector<HTMLElement>('.frame')!;
        document.body.appendChild(root);
        const rect = frame.getBoundingClientRect();
        const down = new PointerEvent('pointerdown', {
            pointerId: 1,
            clientX: rect.left + 100,
            clientY: rect.top + 50,
            bubbles: true,
        });
        frame.dispatchEvent(down);
        frame.dispatchEvent(
            new PointerEvent('pointermove', {
                pointerId: 1,
                clientX: rect.left + 100 + rect.width * 0.2,
                clientY: rect.top + 50,
                bubbles: true,
            })
        );
        expect(fixture.componentInstance.draft().position_x).toBe(30);
        frame.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
        frame.dispatchEvent(
            new PointerEvent('pointermove', {
                pointerId: 1,
                clientX: rect.left + 400,
                clientY: rect.top + 50,
                bubbles: true,
            })
        );
        expect(fixture.componentInstance.draft().position_x).toBe(30);
        root.remove();
    });

    it('arrow keys move the picture and Shift moves it further', () => {
        const frame = root.querySelector<HTMLElement>('.frame')!;
        frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(fixture.componentInstance.draft().position_x).toBe(51);
        frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
        expect(fixture.componentInstance.draft().position_y).toBe(60);
    });

    it('Escape closes the editor and nothing else', () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(closed).toBe(1);
        expect(store.update).not.toHaveBeenCalled();
    });

    it('removes the image after confirming and closes', async () => {
        await fixture.componentInstance.remove();
        expect(confirm.ask).toHaveBeenCalled();
        expect(store.removeBackgroundImage).toHaveBeenCalled();
        expect(closed).toBe(1);
    });

    it('shows a replace error without losing the draft', async () => {
        store.uploadBackgroundImage.and.resolveTo({ ok: false, message: 'Nope.' });
        input(slider('zoom'), '200');
        await fixture.componentInstance.replace(new File([], 'x.png', { type: 'image/png' }));
        fixture.detectChanges();
        expect(root.querySelector('.error')?.textContent).toContain('Nope.');
        expect(fixture.componentInstance.draft().zoom).toBe(200);
    });
});
