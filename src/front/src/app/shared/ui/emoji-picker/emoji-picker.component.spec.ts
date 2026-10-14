import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EMOJI_CATEGORIES } from './emoji-data';
import { EmojiPickerComponent } from './emoji-picker.component';

describe('EmojiPickerComponent', () => {
    let fixture: ComponentFixture<EmojiPickerComponent>;

    function create(): HTMLElement {
        fixture = TestBed.createComponent(EmojiPickerComponent);
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [EmojiPickerComponent] }).compileComponents();
    });

    it('renders the first category by default', () => {
        const host = create();
        const buttons = host.querySelectorAll('.emoji');
        expect(buttons.length).toBe(EMOJI_CATEGORIES[0].emoji.length);
    });

    it('switches category when a tab is clicked', () => {
        const host = create();
        const tabs = host.querySelectorAll<HTMLButtonElement>('.tab');
        expect(tabs.length).toBe(EMOJI_CATEGORIES.length);

        tabs[1].click();
        fixture.detectChanges();

        const buttons = host.querySelectorAll('.emoji');
        expect(buttons.length).toBe(EMOJI_CATEGORIES[1].emoji.length);
    });

    it('emits pick with the chosen emoji', () => {
        const host = create();
        const spy = jasmine.createSpy('pick');
        fixture.componentInstance.pick.subscribe(spy);

        const first = host.querySelector<HTMLButtonElement>('.emoji')!;
        first.click();

        expect(spy).toHaveBeenCalledWith(EMOJI_CATEGORIES[0].emoji[0]);
    });

    it('emits closeRequested on a mousedown outside the picker', () => {
        create();
        const spy = jasmine.createSpy('closeRequested');
        fixture.componentInstance.closeRequested.subscribe(spy);

        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(spy).toHaveBeenCalled();
    });

    it('does not close when the outside mousedown target is the trigger', () => {
        create();
        const spy = jasmine.createSpy('closeRequested');
        fixture.componentInstance.closeRequested.subscribe(spy);

        const trigger = document.createElement('button');
        trigger.className = 'emoji-trigger';
        document.body.appendChild(trigger);

        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        trigger.remove();

        expect(spy).not.toHaveBeenCalled();
    });

    it('emits closeRequested on Escape', () => {
        create();
        const spy = jasmine.createSpy('closeRequested');
        fixture.componentInstance.closeRequested.subscribe(spy);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(spy).toHaveBeenCalled();
    });
});
