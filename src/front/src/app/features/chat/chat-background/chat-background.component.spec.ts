import { TestBed } from '@angular/core/testing';

import { DEFAULT_BACKGROUND_IMAGE } from '../../../core/models/appearance.model';
import { BackgroundImageService } from '../../../core/services/background-image.service';
import { backgroundLayerStyle, ChatBackgroundComponent, dimStyle } from './chat-background.component';

describe('backgroundLayerStyle', () => {
    const image = { ...DEFAULT_BACKGROUND_IMAGE, version: 'v1' };

    it('maps fit, position, zoom and blur to CSS', () => {
        const style = backgroundLayerStyle(
            { ...image, fit: 'contain', position_x: 20, position_y: 70, zoom: 200, blur: 8 },
            'blob:x'
        );
        expect(style['background-size']).toBe('contain');
        expect(style['background-position']).toBe('20% 70%');
        expect(style['transform-origin']).toBe('20% 70%');
        expect(style['filter']).toBe('blur(8px)');
        expect(style['transform']).toBe('scale(2.1)');
    });

    it('repeats a tiled image and leaves an unblurred one unfiltered and unscaled', () => {
        const style = backgroundLayerStyle({ ...image, fit: 'tile' }, 'blob:x');
        expect(style['background-repeat']).toBe('repeat');
        expect(style['background-size']).toBe('auto');
        expect(style['filter']).toBe('none');
        expect(style['transform']).toBe('scale(1)');
    });

    it('lays a black veil of the dim percentage', () => {
        expect(dimStyle({ ...image, dim: 40 })['background']).toBe('rgb(0 0 0 / 40%)');
    });
});

describe('ChatBackgroundComponent', () => {
    function create(load: () => Promise<string | null>, version: string | null) {
        TestBed.configureTestingModule({
            providers: [{ provide: BackgroundImageService, useValue: { load } }],
        });
        const fixture = TestBed.createComponent(ChatBackgroundComponent);
        fixture.componentRef.setInput('image', { ...DEFAULT_BACKGROUND_IMAGE, dim: 30, version });
        fixture.componentRef.setInput('version', version);
        fixture.detectChanges();
        return fixture;
    }

    it('renders the picture and the veil once the blob is available', async () => {
        const fixture = create(() => Promise.resolve('blob:abc'), 'v1');
        await fixture.whenStable();
        fixture.detectChanges();
        const root = fixture.nativeElement as HTMLElement;
        expect((root.querySelector('.layer') as HTMLElement).style.backgroundImage).toContain('blob:abc');
        expect((root.querySelector('.dim') as HTMLElement).style.background).toContain('0.3');
    });

    it('renders nothing when the image cannot be fetched, leaving the default background', async () => {
        const fixture = create(() => Promise.resolve(null), 'v1');
        await fixture.whenStable();
        fixture.detectChanges();
        expect((fixture.nativeElement as HTMLElement).querySelector('.layer')).toBeNull();
    });
});
