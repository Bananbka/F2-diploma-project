import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { StickerPack, StickerPackSummary } from '../../../../core/models/sticker.model';
import { DirectoryService } from '../../../../core/services/directory.service';
import { StickerApiService } from '../../../../core/services/sticker-api.service';
import { StickerPackDialogComponent } from './sticker-pack-dialog.component';

const URL = 'https://files.test/s1.png';

const PACK: StickerPack = {
    id: 'pack-a',
    owner_id: 'user-9',
    title: 'Cats',
    is_public: true,
    stickers: [
        { id: 's1', pack_id: 'pack-a', image_url: URL, emoji: '😀', position: 0 },
        { id: 's2', pack_id: 'pack-a', image_url: 'https://files.test/s2.png', emoji: '😂', position: 1 },
    ],
};

describe('StickerPackDialogComponent', () => {
    let fixture: ComponentFixture<StickerPackDialogComponent>;
    let api: jasmine.SpyObj<StickerApiService>;
    let directory: jasmine.SpyObj<DirectoryService>;

    async function render(): Promise<HTMLElement> {
        fixture = TestBed.createComponent(StickerPackDialogComponent);
        fixture.componentRef.setInput('stickerUrl', URL);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(async () => {
        api = jasmine.createSpyObj<StickerApiService>('StickerApiService', [
            'getPackByUrl',
            'getMyPacks',
            'subscribe',
            'unsubscribe',
        ]);
        api.getPackByUrl.and.returnValue(of(PACK));
        api.getMyPacks.and.returnValue(of([] as StickerPackSummary[]));
        api.subscribe.and.returnValue(of(null));
        api.unsubscribe.and.returnValue(of(null));
        directory = jasmine.createSpyObj<DirectoryService>('DirectoryService', ['isMe']);
        directory.isMe.and.returnValue(false);

        await TestBed.configureTestingModule({
            imports: [StickerPackDialogComponent],
            providers: [
                { provide: StickerApiService, useValue: api },
                { provide: DirectoryService, useValue: directory },
            ],
        }).compileComponents();
    });

    it('resolves the pack from the sticker url and shows its name and stickers', async () => {
        const host = await render();

        expect(api.getPackByUrl).toHaveBeenCalledOnceWith(URL);
        expect(host.querySelector('.title')?.textContent).toContain('Cats');
        expect(host.querySelectorAll('.grid img').length).toBe(2);
        expect(host.querySelector('.subscribe-btn')?.textContent).toContain('Subscribe');
    });

    it('shows Unsubscribe when the pack is already in the tray, and toggles via the API', async () => {
        api.getMyPacks.and.returnValue(of([{ id: 'pack-a' } as StickerPackSummary]));
        const host = await render();
        const button = host.querySelector<HTMLButtonElement>('.subscribe-btn')!;
        expect(button.textContent).toContain('Unsubscribe');

        button.click();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(api.unsubscribe).toHaveBeenCalledOnceWith('pack-a');
        expect(host.querySelector('.subscribe-btn')?.textContent).toContain('Subscribe');
    });

    it("offers no subscribe control for the viewer's own pack", async () => {
        directory.isMe.and.returnValue(true);
        const host = await render();

        expect(host.querySelector('.subscribe-btn')).toBeNull();
    });

    it('404 STICKER_PACK_UNAVAILABLE shows an explicit "Pack is unavailable" state', async () => {
        api.getPackByUrl.and.returnValue(
            throwError(
                () =>
                    new HttpErrorResponse({
                        status: 404,
                        error: { status: 'error', error_code: 'STICKER_PACK_UNAVAILABLE', message: 'gone' },
                    })
            )
        );
        const host = await render();

        expect(host.querySelector('[role="alert"]')?.textContent).toContain('Pack is unavailable');
        expect(host.querySelector('.grid')).toBeNull();
    });

    it('any other failure is a retryable error, not reported as unavailable', async () => {
        api.getPackByUrl.and.returnValue(throwError(() => new HttpErrorResponse({ status: 500 })));
        const host = await render();

        expect(host.textContent).toContain('Could not load this pack');
        expect(host.textContent).not.toContain('Pack is unavailable');
        expect(host.querySelector('.retry')).not.toBeNull();
    });

    it('emits closed on Escape and on backdrop click', async () => {
        const host = await render();
        let closed = 0;
        fixture.componentInstance.closed.subscribe(() => closed++);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        host.querySelector<HTMLElement>('.backdrop')!.click();

        expect(closed).toBe(2);
    });
});
