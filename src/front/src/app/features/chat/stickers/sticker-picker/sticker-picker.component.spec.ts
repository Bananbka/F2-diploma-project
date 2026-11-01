import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';

import { Sticker, StickerPack, StickerPackSummary } from '../../../../core/models/sticker.model';
import { StickerApiService } from '../../../../core/services/sticker-api.service';
import { StickerPickerComponent } from './sticker-picker.component';

const PACK_A: StickerPackSummary = {
    id: 'pack-a',
    owner_id: 'user-1',
    title: 'Cats',
    is_public: false,
    sticker_count: 2,
    cover_image_url: 'https://files.test/cats-cover.png',
};

const PACK_B: StickerPackSummary = {
    id: 'pack-b',
    owner_id: 'user-2',
    title: 'Dogs',
    is_public: true,
    sticker_count: 1,
    cover_image_url: null,
};

const STICKERS_A: Sticker[] = [
    { id: 's1', pack_id: 'pack-a', image_url: 'https://files.test/s1.png', emoji: '😀', position: 0 },
    { id: 's2', pack_id: 'pack-a', image_url: 'https://files.test/s2.png', emoji: '😂', position: 1 },
];
const STICKERS_B: Sticker[] = [
    { id: 's3', pack_id: 'pack-b', image_url: 'https://files.test/s3.png', emoji: '🐶', position: 0 },
];

const DETAILS: Record<string, StickerPack> = {
    'pack-a': { id: 'pack-a', owner_id: 'user-1', title: 'Cats', is_public: false, stickers: STICKERS_A },
    'pack-b': { id: 'pack-b', owner_id: 'user-2', title: 'Dogs', is_public: true, stickers: STICKERS_B },
};

describe('StickerPickerComponent', () => {
    let fixture: ComponentFixture<StickerPickerComponent>;
    let stickerApi: jasmine.SpyObj<StickerApiService>;

    function host(): HTMLElement {
        return fixture.nativeElement as HTMLElement;
    }

    async function render(): Promise<void> {
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
    }

    beforeEach(async () => {
        stickerApi = jasmine.createSpyObj<StickerApiService>('StickerApiService', ['getMyPacks', 'getPack']);
        stickerApi.getMyPacks.and.returnValue(of([PACK_A, PACK_B]));
        stickerApi.getPack.and.callFake((id: string) => of(DETAILS[id]));

        await TestBed.configureTestingModule({
            imports: [StickerPickerComponent],
            providers: [{ provide: StickerApiService, useValue: stickerApi }, provideRouter([])],
        }).compileComponents();

        fixture = TestBed.createComponent(StickerPickerComponent);
    });

    it('lists every pack as a labelled section in one list, not one pack at a time', async () => {
        await render();

        expect(stickerApi.getPack).toHaveBeenCalledWith('pack-a');
        expect(stickerApi.getPack).toHaveBeenCalledWith('pack-b');
        const titles = Array.from(host().querySelectorAll('.section-title')).map((el) => el.textContent?.trim());
        expect(titles).toEqual(['Cats', 'Dogs']);
        expect(host().querySelectorAll('section .sticker').length).toBe(3);
    });

    it('lazy-loads sticker images', async () => {
        await render();

        const images = host().querySelectorAll<HTMLImageElement>('.sticker img');
        expect(images.length).toBeGreaterThan(0);
        images.forEach((img) => expect(img.getAttribute('loading')).toBe('lazy'));
    });

    it('emits the picked sticker', async () => {
        await render();
        let picked: Sticker | undefined;
        fixture.componentInstance.stickerPicked.subscribe((s) => (picked = s));

        host().querySelectorAll<HTMLButtonElement>('.sticker')[0].click();

        expect(picked).toEqual(STICKERS_A[0]);
    });

    it('has no popover behaviour: an outside mousedown asks for nothing', async () => {
        await render();

        expect('closeRequested' in fixture.componentInstance).toBeFalse();
    });

    it('shows Recently used first, resolved from ids against the loaded packs, dropping unknown ids', async () => {
        fixture.componentRef.setInput('recentIds', ['s3', 'gone', 's1']);
        await render();

        const titles = Array.from(host().querySelectorAll('.section-title')).map((el) => el.textContent?.trim());
        expect(titles).toEqual(['Recently used', 'Cats', 'Dogs']);
        const recent = host().querySelectorAll('section[data-section="recent"] .sticker');
        expect(recent.length).toBe(2);
        expect(recent[0].querySelector('img')?.getAttribute('src')).toBe('https://files.test/s3.png');
    });

    it('filters across all packs by emoji', async () => {
        await render();

        fixture.componentInstance.query.set('🐶');
        fixture.detectChanges();

        expect(host().querySelectorAll('.sticker').length).toBe(1);
        expect(host().querySelector('.section-title')).toBeNull();
    });

    it('has a bottom bar with one icon per pack that scrolls to its section and highlights it', async () => {
        await render();
        const bar = host().querySelectorAll<HTMLButtonElement>('.bar .bar-item');
        expect(bar.length).toBe(2);
        expect(bar[0].classList.contains('is-active')).toBeTrue();

        const scroller = host().querySelector<HTMLElement>('.scroll')!;
        const scrollTo = spyOn(scroller, 'scrollTo');
        bar[1].click();
        fixture.detectChanges();
        await new Promise((resolve) => setTimeout(resolve));

        expect(scrollTo).toHaveBeenCalled();
        expect(bar[1].classList.contains('is-active')).toBeTrue();
        expect(bar[0].classList.contains('is-active')).toBeFalse();
    });

    it('highlights the pack in view while scrolling', async () => {
        await render();
        const scroller = host().querySelector<HTMLElement>('.scroll')!;
        const second = host().querySelector<HTMLElement>('[data-section="pack-b"]')!;
        // Pretend the second section has reached the top of the list.
        scroller.scrollTop = second.offsetTop;
        spyOnProperty(second, 'offsetTop').and.returnValue(0);
        scroller.dispatchEvent(new Event('scroll'));
        fixture.detectChanges();

        expect(fixture.componentInstance.activeSection()).toBe('pack-b');
    });

    it('keeps Manage packs and Discover entry points', async () => {
        await render();

        const links = Array.from(host().querySelectorAll('.foot a')).map((a) => a.getAttribute('href'));
        expect(links).toEqual(['/stickers/manage', '/stickers/discover']);
    });

    it('still shows the packs that loaded when one fails', async () => {
        stickerApi.getPack.and.callFake((id: string) =>
            id === 'pack-a' ? throwError(() => new Error('boom')) : of(DETAILS[id])
        );
        await render();

        expect(host().querySelectorAll('.section-title').length).toBe(1);
        expect(host().querySelector('.error')?.textContent).toContain('Some packs');
    });

    it('says so when there are no packs', async () => {
        stickerApi.getMyPacks.and.returnValue(of([]));
        await render();

        expect(host().querySelector('.empty')?.textContent).toContain('no sticker packs');
    });
});
