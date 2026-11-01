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

    describe('embedded (side panel)', () => {
        function createEmbedded(recents: string[] = []): HTMLElement {
            fixture = TestBed.createComponent(EmojiPickerComponent);
            fixture.componentRef.setInput('embedded', true);
            fixture.componentRef.setInput('recents', recents);
            fixture.detectChanges();
            return fixture.nativeElement as HTMLElement;
        }

        it('is one list with a titled section per category, not one category at a time', () => {
            const host = createEmbedded();

            const titles = Array.from(host.querySelectorAll('.section-title')).map((el) => el.textContent?.trim());
            expect(titles).toEqual(EMOJI_CATEGORIES.map((c) => c.label));
            const total = EMOJI_CATEGORIES.reduce((n, c) => n + c.emoji.length, 0);
            expect(host.querySelectorAll('.scroll .emoji').length).toBe(total);
        });

        it('never closes itself on outside clicks or Escape', () => {
            createEmbedded();
            const spy = jasmine.createSpy('closeRequested');
            fixture.componentInstance.closeRequested.subscribe(spy);

            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(spy).not.toHaveBeenCalled();
        });

        it('lists Recently used first when there are recents', () => {
            const host = createEmbedded(['😀', '🐶']);

            const titles = Array.from(host.querySelectorAll('.section-title')).map((el) => el.textContent?.trim());
            expect(titles[0]).toBe('Recently used');
            expect(host.querySelectorAll('section[data-section="recent"] .emoji').length).toBe(2);
        });

        it('omits Recently used when there are none', () => {
            const host = createEmbedded();

            expect(host.querySelector('[data-section="recent"]')).toBeNull();
        });

        it('searches by category label and by the emoji itself', () => {
            const host = createEmbedded();
            const first = EMOJI_CATEGORIES[0];

            fixture.componentInstance.query.set(first.label.toLowerCase());
            fixture.detectChanges();
            expect(host.querySelectorAll('.scroll .emoji').length).toBe(first.emoji.length);

            fixture.componentInstance.query.set(first.emoji[0]);
            fixture.detectChanges();
            expect(host.querySelectorAll('.scroll .emoji').length).toBe(1);

            fixture.componentInstance.query.set('zzzz-no-such-thing');
            fixture.detectChanges();
            expect(host.querySelector('.muted')?.textContent).toContain('No emoji match');
        });

        it('has a category bar that scrolls to the section and highlights it', async () => {
            const host = createEmbedded();
            const items = host.querySelectorAll<HTMLButtonElement>('.bar .bar-item');
            expect(items.length).toBe(EMOJI_CATEGORIES.length);
            expect(items[0].classList.contains('is-active')).toBeTrue();

            const scroller = host.querySelector<HTMLElement>('.scroll')!;
            const scrollTo = spyOn(scroller, 'scrollTo');
            items[2].click();
            fixture.detectChanges();
            await new Promise((resolve) => setTimeout(resolve));

            expect(scrollTo).toHaveBeenCalled();
            expect(items[2].classList.contains('is-active')).toBeTrue();
            expect(items[0].classList.contains('is-active')).toBeFalse();
        });

        it('emits pick from the list', () => {
            const host = createEmbedded();
            const spy = jasmine.createSpy('pick');
            fixture.componentInstance.pick.subscribe(spy);

            host.querySelector<HTMLButtonElement>('.scroll .emoji')!.click();

            expect(spy).toHaveBeenCalledWith(EMOJI_CATEGORIES[0].emoji[0]);
        });
    });
});
