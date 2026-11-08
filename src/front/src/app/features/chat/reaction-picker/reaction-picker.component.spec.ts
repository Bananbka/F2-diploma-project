import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SessionService } from '../../../core/services/session.service';
import { BUILT_IN_REACTIONS, ReactionPickerComponent } from './reaction-picker.component';
import { DEFAULT_REACTIONS, ReactionRecentsService, RECENT_REACTIONS_CAP } from './reaction-recents.service';

describe('ReactionRecentsService', () => {
    let userId: string;

    function create(): ReactionRecentsService {
        TestBed.configureTestingModule({
            providers: [{ provide: SessionService, useValue: { user: () => ({ id: userId }) } }],
        });
        return TestBed.inject(ReactionRecentsService);
    }

    beforeEach(() => {
        userId = 'u-recents';
        localStorage.removeItem('reaction-recents.v1:u-recents');
        localStorage.removeItem('reaction-recents.v1:u-other');
    });

    it('falls back to the defaults with no history', () => {
        expect(create().quickBar()).toEqual([...DEFAULT_REACTIONS]);
    });

    it('puts the most recent first, de-duplicates, and tops the bar up from the defaults', () => {
        const service = create();
        service.record('🔥');
        service.record('👍');
        service.record('🔥');
        expect(service.recents()).toEqual(['🔥', '👍']);
        const bar = service.quickBar();
        expect(bar.slice(0, 2)).toEqual(['🔥', '👍']);
        expect(bar.length).toBe(6);
        expect(new Set(bar).size).toBe(bar.length);
    });

    it('caps the list', () => {
        const service = create();
        for (let i = 0; i < 20; i++) {
            service.record(String.fromCodePoint(0x1f600 + i));
        }
        expect(service.recents().length).toBe(RECENT_REACTIONS_CAP);
        expect(service.recents()[0]).toBe(String.fromCodePoint(0x1f600 + 19));
    });

    it('persists per user', () => {
        create().record('🥰');
        expect(JSON.parse(localStorage.getItem('reaction-recents.v1:u-recents')!)).toEqual(['🥰']);
        TestBed.resetTestingModule();
        expect(create().recents()).toEqual(['🥰']);
        TestBed.resetTestingModule();
        userId = 'u-other';
        expect(create().recents()).toEqual([]);
    });
});

describe('ReactionPickerComponent', () => {
    let fixture: ComponentFixture<ReactionPickerComponent>;
    let picked: string[];
    let closed: number;
    let anchor: HTMLButtonElement;

    beforeEach(() => {
        localStorage.removeItem('reaction-recents.v1:u-picker');
        TestBed.configureTestingModule({
            providers: [{ provide: SessionService, useValue: { user: () => ({ id: 'u-picker' }) } }],
        });
        anchor = document.createElement('button');
        document.body.appendChild(anchor);
        fixture = TestBed.createComponent(ReactionPickerComponent);
        fixture.componentRef.setInput('anchor', anchor);
        fixture.componentRef.setInput('mine', ['👍']);
        picked = [];
        closed = 0;
        fixture.componentInstance.picked.subscribe((e) => picked.push(e));
        fixture.componentInstance.closed.subscribe(() => closed++);
        fixture.detectChanges();
    });

    afterEach(() => {
        fixture.destroy();
        anchor.remove();
        localStorage.removeItem('reaction-recents.v1:u-picker');
    });

    const popover = () => document.body.querySelector('.reactions-picker') as HTMLElement | null;
    const emojiButtons = (selector: string) => Array.from(popover()!.querySelectorAll<HTMLElement>(selector));

    it('opens as a body-level popover with the quick bar and no text input', () => {
        expect(popover()).not.toBeNull();
        expect(popover()!.querySelector('input[type="text"]')).toBeNull();
        expect(emojiButtons('.quick .emoji').length).toBe(6);
        expect(popover()!.querySelector('.expand')).not.toBeNull();
    });

    it('keeps my own reaction highlighted', () => {
        const mine = emojiButtons('.quick .emoji').filter((b) => b.classList.contains('is-mine'));
        expect(mine.length).toBe(1);
        expect(mine[0].getAttribute('aria-pressed')).toBe('true');
    });

    it('expands in place to the 17 built-ins, in order', () => {
        (popover()!.querySelector('.expand') as HTMLButtonElement).click();
        fixture.detectChanges();
        const grid = emojiButtons('.grid .emoji').map((b) => b.getAttribute('aria-label'));
        expect(grid.length).toBe(17);
        expect(BUILT_IN_REACTIONS.length).toBe(17);
        expect(BUILT_IN_REACTIONS.join('')).toBe('💀🥰🔥💔❤️😭🤡😡🙏👍👎🍌😨😢😁💩🐷');
        expect(popover()!.querySelector('.more-emoji')).not.toBeNull();
    });

    it('More emoji opens the full picker in the same popover', () => {
        (popover()!.querySelector('.expand') as HTMLButtonElement).click();
        fixture.detectChanges();
        (popover()!.querySelector('.more-emoji') as HTMLButtonElement).click();
        fixture.detectChanges();
        expect(popover()!.querySelector('app-emoji-picker')).not.toBeNull();
        expect(document.body.querySelectorAll('.reactions-picker').length).toBe(1);
    });

    it('picking records a recent, reports it and closes', () => {
        (popover()!.querySelector('.expand') as HTMLButtonElement).click();
        fixture.detectChanges();
        emojiButtons('.grid .emoji')[2].click();
        expect(picked).toEqual(['🔥']);
        expect(closed).toBe(1);
        expect(TestBed.inject(ReactionRecentsService).recents()[0]).toBe('🔥');
    });

    it('arrow keys move focus between the buttons', () => {
        const buttons = emojiButtons('button[data-nav]');
        buttons[0].focus();
        popover()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(document.activeElement).toBe(buttons[1]);
    });

    it('Escape closes the popover and is not seen by the rest of the page', () => {
        const reached = jasmine.createSpy('reached');
        document.addEventListener('keydown', reached);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        document.removeEventListener('keydown', reached);
        expect(closed).toBe(1);
        expect(reached).not.toHaveBeenCalled();
    });

    it('removes itself from the body when destroyed', () => {
        fixture.destroy();
        expect(popover()).toBeNull();
    });
});
