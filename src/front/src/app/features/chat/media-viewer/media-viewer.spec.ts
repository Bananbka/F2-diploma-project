import { TestBed } from '@angular/core/testing';

import { MediaViewerComponent, ZOOM_MAX } from './media-viewer.component';
import { MediaViewerService, ViewerItem } from './media-viewer.service';

const item = (n: number, extra: Partial<ViewerItem> = {}): ViewerItem => ({
    key: `url-${n}`,
    messageId: `m${n}`,
    objectUrl: `blob:${n}`,
    name: `pic-${n}.png`,
    contentType: 'image/png',
    kind: 'image',
    sender: 'Ada',
    time: `10:0${n}`,
    ...extra,
});

describe('MediaViewerService', () => {
    let service: MediaViewerService;

    beforeEach(() => {
        service = TestBed.inject(MediaViewerService);
        // Registered out of order on purpose: the viewer orders by message.
        service.register('c1', item(3));
        service.register('c1', item(1));
        service.register('c1', item(2));
        service.register('other', item(9));
    });

    it('lists a chat media in message order and ignores other chats', () => {
        expect(service.itemsOf('c1').map((i) => i.key)).toEqual(['url-1', 'url-2', 'url-3']);
    });

    it('steps next and previous, stopping at the ends', () => {
        service.open('c1', 'url-2');
        service.step(1);
        expect(service.item()?.key).toBe('url-3');
        service.step(1);
        expect(service.item()?.key).toBe('url-3');
        service.step(-2);
        expect(service.item()?.key).toBe('url-1');
        service.step(-1);
        expect(service.item()?.key).toBe('url-1');
    });

    it('closes when the open picture goes away', () => {
        service.open('c1', 'url-1');
        service.unregister('url-1');
        expect(service.current()).toBeNull();
    });

    it('will not open something that is not decrypted', () => {
        service.open('c1', 'missing');
        expect(service.current()).toBeNull();
    });
});

describe('MediaViewerComponent', () => {
    let service: MediaViewerService;

    function open(key = 'url-2') {
        service.open('c1', key);
        const fixture = TestBed.createComponent(MediaViewerComponent);
        fixture.detectChanges();
        return fixture;
    }

    beforeEach(() => {
        service = TestBed.inject(MediaViewerService);
        service.register('c1', item(1, { contentType: 'image/jpeg', name: 'one.jpg' }));
        service.register('c1', item(2));
        service.register('c1', item(3));
    });

    it('shows the picture with a counter, the sender and time, a download link and the white backing', () => {
        const fixture = open();
        const root = fixture.nativeElement as HTMLElement;
        expect(root.querySelector('.picture')?.getAttribute('src')).toBe('blob:2');
        expect(root.querySelector('.counter')?.textContent).toContain('2 / 3');
        expect(root.querySelector('.caption')?.textContent).toContain('Ada');
        expect(root.querySelector('.caption')?.textContent).toContain('10:02');
        const download = root.querySelector('a[aria-label="Download"]')!;
        expect(download.getAttribute('href')).toBe('blob:2');
        expect(download.getAttribute('download')).toBe('pic-2.png');
        expect(root.querySelector('.picture')?.classList.contains('has-alpha')).toBeTrue();
    });

    it('does not give an opaque JPEG the white backing', () => {
        const root = open('url-1').nativeElement as HTMLElement;
        expect(root.querySelector('.picture')?.classList.contains('has-alpha')).toBeFalse();
    });

    it('steps with the buttons and the arrow keys, in order', () => {
        const fixture = open();
        const root = fixture.nativeElement as HTMLElement;
        (root.querySelector('.nav.next') as HTMLButtonElement).click();
        fixture.detectChanges();
        expect(root.querySelector('.picture')?.getAttribute('src')).toBe('blob:3');
        expect(root.querySelector('.nav.next')).toBeNull();
        root.querySelector('.viewer')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        fixture.detectChanges();
        expect(root.querySelector('.picture')?.getAttribute('src')).toBe('blob:2');
    });

    it('zooms with the buttons, the wheel and double-click, within limits, and resets on another picture', () => {
        const fixture = open();
        const root = fixture.nativeElement as HTMLElement;
        (root.querySelector('button[aria-label="Zoom in"]') as HTMLButtonElement).click();
        expect(fixture.componentInstance.zoom()).toBe(1.5);
        root.querySelector('.stage')!.dispatchEvent(
            new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
        );
        expect(fixture.componentInstance.zoom()).toBe(2);
        fixture.componentInstance.setZoom(99);
        expect(fixture.componentInstance.zoom()).toBe(ZOOM_MAX);
        fixture.componentInstance.setZoom(1);
        root.querySelector('.picture')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(fixture.componentInstance.zoom()).toBe(2.5);
        fixture.componentInstance.next();
        fixture.detectChanges();
        expect(fixture.componentInstance.zoom()).toBe(1);
    });

    it('pans only while zoomed', () => {
        const fixture = open();
        const stage = (fixture.nativeElement as HTMLElement).querySelector('.stage') as HTMLElement;
        const pointer = (type: string, x: number, y: number) =>
            stage.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true }));
        pointer('pointerdown', 10, 10);
        pointer('pointermove', 40, 10);
        expect(fixture.componentInstance.panX()).toBe(0);
        fixture.componentInstance.setZoom(2);
        pointer('pointerdown', 10, 10);
        pointer('pointermove', 40, 25);
        expect(fixture.componentInstance.panX()).toBe(30);
        expect(fixture.componentInstance.panY()).toBe(15);
        pointer('pointerup', 0, 0);
        pointer('pointermove', 100, 100);
        expect(fixture.componentInstance.panX()).toBe(30);
    });

    it('Escape and the close button close it', () => {
        open();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(service.current()).toBeNull();
        const again = open();
        ((again.nativeElement as HTMLElement).querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
        expect(service.current()).toBeNull();
    });
});
