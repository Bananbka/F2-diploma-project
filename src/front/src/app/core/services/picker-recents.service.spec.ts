import { TestBed } from '@angular/core/testing';

import { PickerRecentsService } from './picker-recents.service';
import { SessionService } from './session.service';

describe('PickerRecentsService removal', () => {
    let recents: PickerRecentsService;

    beforeEach(() => {
        localStorage.clear();
        TestBed.configureTestingModule({
            providers: [{ provide: SessionService, useValue: { user: () => ({ id: 'u1' }) } }],
        });
        recents = TestBed.inject(PickerRecentsService);
    });

    afterEach(() => localStorage.clear());

    it('removes one emoji and keeps the rest in order', () => {
        recents.addEmoji('a');
        recents.addEmoji('b');
        recents.addEmoji('c');

        recents.removeEmoji('b');

        expect(recents.emoji()).toEqual(['c', 'a']);
    });

    it('removes a sticker id and persists it', () => {
        recents.addSticker('s1');
        recents.addSticker('s2');

        recents.removeSticker('s1');

        expect(recents.stickerIds()).toEqual(['s2']);
        expect(JSON.parse(localStorage.getItem('picker-recents:u1:stickers')!)).toEqual(['s2']);
    });

    it('ignores a value that is not in the list', () => {
        recents.addEmoji('a');
        recents.removeEmoji('zzz');
        expect(recents.emoji()).toEqual(['a']);
    });
});
