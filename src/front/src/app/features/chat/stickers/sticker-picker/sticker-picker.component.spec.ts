import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

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

const STICKERS: Sticker[] = [
    { id: 's1', pack_id: 'pack-a', image_url: 'https://files.test/s1.png', emoji: '😀', position: 0 },
    { id: 's2', pack_id: 'pack-a', image_url: 'https://files.test/s2.png', emoji: '😂', position: 1 },
];

const PACK_A_DETAIL: StickerPack = {
    id: 'pack-a',
    owner_id: 'user-1',
    title: 'Cats',
    is_public: false,
    stickers: STICKERS,
};

describe('StickerPickerComponent', () => {
    let fixture: ComponentFixture<StickerPickerComponent>;
    let stickerApi: jasmine.SpyObj<StickerApiService>;

    async function render(): Promise<void> {
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
    }

    beforeEach(async () => {
        stickerApi = jasmine.createSpyObj<StickerApiService>('StickerApiService', ['getMyPacks', 'getPack']);
        stickerApi.getMyPacks.and.returnValue(of([PACK_A]));
        stickerApi.getPack.and.returnValue(of(PACK_A_DETAIL));

        await TestBed.configureTestingModule({
            imports: [StickerPickerComponent],
            providers: [{ provide: StickerApiService, useValue: stickerApi }, provideRouter([])],
        }).compileComponents();

        fixture = TestBed.createComponent(StickerPickerComponent);
    });

    it('loads the tray and the first pack, then renders its stickers', async () => {
        await render();

        expect(stickerApi.getMyPacks).toHaveBeenCalled();
        expect(stickerApi.getPack).toHaveBeenCalledWith('pack-a');

        const images = (fixture.nativeElement as HTMLElement).querySelectorAll('.sticker img');
        expect(images.length).toBe(2);
    });

    it('emits the picked sticker', async () => {
        await render();

        let picked: Sticker | undefined;
        fixture.componentInstance.stickerPicked.subscribe((s) => (picked = s));

        const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.sticker');
        buttons[0].click();

        expect(picked).toEqual(STICKERS[0]);
    });

    it('asks to close on an outside mousedown', async () => {
        await render();

        let closed = false;
        fixture.componentInstance.closeRequested.subscribe(() => (closed = true));

        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(closed).toBeTrue();
    });

    it('does not ask to close on a mousedown inside the popover', async () => {
        await render();

        let closed = false;
        fixture.componentInstance.closeRequested.subscribe(() => (closed = true));

        const picker = (fixture.nativeElement as HTMLElement).querySelector('.picker') as HTMLElement;
        picker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(closed).toBeFalse();
    });

    it('filters the active pack by emoji', async () => {
        await render();

        fixture.componentInstance.query.set('😂');
        fixture.detectChanges();

        const images = (fixture.nativeElement as HTMLElement).querySelectorAll('.sticker img');
        expect(images.length).toBe(1);
    });
});
