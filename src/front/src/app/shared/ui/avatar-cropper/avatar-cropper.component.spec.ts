import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AvatarCropperComponent } from './avatar-cropper.component';
import {
    assertPixelBudget,
    clampOutputSize,
    decodeImage,
    MAX_DECODE_SIDE,
    MAX_OUTPUT_SIZE,
    MAX_SOURCE_PIXELS,
    MIN_OUTPUT_SIZE,
    OUTPUT_SIZE,
} from './avatar-image';

async function pngFile(width: number, height: number, name = 'photo.png'): Promise<File> {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#a358f9';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width / 2, height / 2);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    return new File([blob], name, { type: 'image/png' });
}

async function until(condition: () => boolean, label = 'condition'): Promise<void> {
    const deadline = Date.now() + 4000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${label}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('AvatarCropperComponent', () => {
    let fixture: ComponentFixture<AvatarCropperComponent>;
    let component: AvatarCropperComponent;
    let root: HTMLElement;

    async function create(file: File): Promise<void> {
        fixture = TestBed.createComponent(AvatarCropperComponent);
        fixture.componentRef.setInput('file', file);
        component = fixture.componentInstance;
        root = fixture.nativeElement as HTMLElement;
        fixture.detectChanges();
        await until(() => component.status() !== 'loading', 'decode');
        fixture.detectChanges();
    }

    function stage(): HTMLElement {
        return root.querySelector<HTMLElement>('.stage')!;
    }

    function key(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(event);
        fixture.detectChanges();
        return event;
    }

    beforeEach(() => TestBed.configureTestingModule({ imports: [AvatarCropperComponent] }));

    it('is a labelled modal dialog', async () => {
        await create(await pngFile(800, 400));
        const dialog = root.querySelector('[role="dialog"]')!;
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('cropper-title');
        expect(root.querySelector('#cropper-title')?.textContent).toContain('Adjust your photo');
    });

    it('decodes the picture and starts centred at zoom 1', async () => {
        await create(await pngFile(800, 400));
        expect(component.status()).toBe('ready');
        expect(component.crop()).toEqual({ zoom: 1, cx: 400, cy: 200, rotation: 0 });
        expect((root.querySelector('.btn.is-primary') as HTMLButtonElement).disabled).toBeFalse();
    });

    it('moves with the arrow keys along the long axis only', async () => {
        await create(await pngFile(800, 400));
        const start = component.crop();

        key(stage(), { key: 'ArrowLeft' });
        expect(component.crop().cx).toBeGreaterThan(start.cx);

        key(stage(), { key: 'ArrowDown' });
        expect(component.crop().cy).toBe(start.cy); // the short axis is already fully used at zoom 1
    });

    it('zooms with + and - and resets with 0', async () => {
        await create(await pngFile(800, 800));

        key(stage(), { key: '+' });
        const zoomedIn = component.crop().zoom;
        expect(zoomedIn).toBeGreaterThan(1);

        key(stage(), { key: '-' });
        expect(component.crop().zoom).toBeLessThan(zoomedIn);

        key(stage(), { key: '+' });
        key(stage(), { key: '0' });
        expect(component.crop().zoom).toBe(1);
    });

    it('zooms with the slider and the wheel, within limits', async () => {
        await create(await pngFile(800, 800));
        const slider = root.querySelector<HTMLInputElement>('.slider')!;
        slider.value = '3';
        slider.dispatchEvent(new Event('input'));
        expect(component.crop().zoom).toBeCloseTo(3);

        const wheel = new WheelEvent('wheel', { deltaY: -100000, cancelable: true, bubbles: true });
        stage().dispatchEvent(wheel);
        expect(wheel.defaultPrevented).toBeTrue();
        expect(component.crop().zoom).toBe(component.maxZoom);
    });

    it('rotates a quarter turn and resets', async () => {
        await create(await pngFile(800, 400));
        component.rotate(1);
        expect(component.crop().rotation).toBe(90);
        component.rotate(-1);
        component.rotate(-1);
        expect(component.crop().rotation).toBe(270);
        component.reset();
        expect(component.crop()).toEqual({ zoom: 1, cx: 400, cy: 200, rotation: 0 });
    });

    it('applies to a square 512px image file', async () => {
        await create(await pngFile(1200, 800));
        const applied: File[] = [];
        component.applied.subscribe((f) => applied.push(f));

        await component.apply();

        expect(applied.length).toBe(1);
        expect(['image/webp', 'image/png']).toContain(applied[0].type);
        expect(applied[0].name).toMatch(/^avatar\.(webp|png)$/);
        const bitmap = await createImageBitmap(applied[0]);
        expect(bitmap.width).toBe(512);
        expect(bitmap.height).toBe(512);
        bitmap.close();
    });

    it('cancels from the button and from Escape, without letting Escape reach outer dialogs', async () => {
        await create(await pngFile(400, 400));
        let cancelled = 0;
        component.cancelled.subscribe(() => cancelled++);

        (root.querySelector('.btn:not(.is-primary)') as HTMLButtonElement).click();
        expect(cancelled).toBe(1);

        let escapedToParent = false;
        document.body.addEventListener('keydown', () => (escapedToParent = true), { once: true });
        document.body.appendChild(root);
        const event = key(stage(), { key: 'Escape' });
        expect(cancelled).toBe(2);
        expect(event.defaultPrevented).toBeTrue();
        expect(escapedToParent).toBeFalse();
        root.remove();
    });

    it('explains a file that is not an image', async () => {
        await create(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
        expect(component.status()).toBe('error');
        expect(root.querySelector('[role="alert"]')?.textContent).toContain('not an image');
        expect((root.querySelector('.btn.is-primary') as HTMLButtonElement).disabled).toBeTrue();
    });

    it('explains an image that cannot be decoded', async () => {
        await create(new File([new Uint8Array([1, 2, 3, 4])], 'broken.png', { type: 'image/png' }));
        expect(component.status()).toBe('error');
        expect(root.querySelector('[role="alert"]')?.textContent).toContain('could not be read');
    });

    it('closes the decoded bitmap when destroyed, and returns focus to its opener', async () => {
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();

        const closeSpy = spyOn(ImageBitmap.prototype, 'close').and.callThrough();
        await create(await pngFile(300, 300));
        fixture.destroy();

        expect(closeSpy).toHaveBeenCalled();
        expect(document.activeElement).toBe(opener);
        opener.remove();
    });

    it('never emits, or touches the bitmap, when destroyed while the image is being encoded', async () => {
        await create(await pngFile(300, 300));
        const applied: File[] = [];
        component.applied.subscribe((f) => applied.push(f));

        let finish!: (blob: Blob | null) => void;
        spyOn(HTMLCanvasElement.prototype, 'toBlob').and.callFake((callback: BlobCallback) => {
            finish = callback;
        });

        const pending = component.apply();
        fixture.destroy();
        finish(new Blob(['x'], { type: 'image/webp' }));
        await pending;

        expect(applied).toEqual([]);
        await component.apply(); // a no-op on a destroyed cropper, not an error
        expect(applied).toEqual([]);
    });

    it('clamps an absurd output size', async () => {
        await create(await pngFile(600, 600));
        fixture.componentRef.setInput('outputSize', 100000);
        fixture.detectChanges();
        const applied: File[] = [];
        component.applied.subscribe((f) => applied.push(f));
        await component.apply();

        const bitmap = await createImageBitmap(applied[0]);
        expect(bitmap.width).toBe(MAX_OUTPUT_SIZE);
        bitmap.close();
    });

    it('drops a bitmap that finishes decoding after the component was destroyed', async () => {
        const closeSpy = spyOn(ImageBitmap.prototype, 'close').and.callThrough();
        const file = await pngFile(300, 300);
        fixture = TestBed.createComponent(AvatarCropperComponent);
        fixture.componentRef.setInput('file', file);
        fixture.detectChanges();
        fixture.destroy();

        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(closeSpy).toHaveBeenCalled();
    });
});

describe('decodeImage', () => {
    it('downscales an oversized image to the decode cap', async () => {
        const bitmap = await decodeImage(await pngFile(MAX_DECODE_SIDE + 1000, 40));
        expect(Math.max(bitmap.width, bitmap.height)).toBe(MAX_DECODE_SIDE);
        bitmap.close();
    });

    it('rejects an empty file', async () => {
        await expectAsync(decodeImage(new File([], 'a.png', { type: 'image/png' }))).toBeRejectedWithError(/empty/);
    });

    it('decodes exactly once, already resized, for an oversized image', async () => {
        const file = await pngFile(MAX_DECODE_SIDE + 1000, 40);
        const spy = jasmine.createSpy('createImageBitmap').and.callFake(window.createImageBitmap.bind(window));
        const original = window.createImageBitmap;
        window.createImageBitmap = spy as unknown as typeof createImageBitmap;
        try {
            const bitmap = await decodeImage(file);
            bitmap.close();
        } finally {
            window.createImageBitmap = original;
        }
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.calls.mostRecent().args[1]).toEqual(jasmine.objectContaining({ resizeWidth: MAX_DECODE_SIDE }));
    });

    it('does not resize an image that is already small enough', async () => {
        const bitmap = await decodeImage(await pngFile(120, 80));
        expect([bitmap.width, bitmap.height]).toEqual([120, 80]);
        bitmap.close();
    });

    it('revokes the object URL it used to read the size', async () => {
        const revoke = spyOn(URL, 'revokeObjectURL').and.callThrough();
        (await decodeImage(await pngFile(50, 50))).close();
        expect(revoke).toHaveBeenCalled();
    });

    it('refuses a source above the pixel budget with a clear message', () => {
        expect(() => assertPixelBudget(5000, 5000)).not.toThrow();
        expect(() => assertPixelBudget(10000, 6000)).toThrowError(/too large \(60 megapixels\)/);
        expect(MAX_SOURCE_PIXELS).toBe(50_000_000);
    });

    it('clamps the output size', () => {
        expect(clampOutputSize(10)).toBe(MIN_OUTPUT_SIZE);
        expect(clampOutputSize(5000)).toBe(MAX_OUTPUT_SIZE);
        expect(clampOutputSize(300.4)).toBe(300);
        expect(clampOutputSize(NaN)).toBe(OUTPUT_SIZE);
    });
});
