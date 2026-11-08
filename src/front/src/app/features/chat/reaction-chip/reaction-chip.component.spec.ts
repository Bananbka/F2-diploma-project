import { TestBed } from '@angular/core/testing';

import { ReactionChipComponent } from './reaction-chip.component';

describe('ReactionChipComponent', () => {
    function create(inputs: Record<string, unknown>) {
        const fixture = TestBed.createComponent(ReactionChipComponent);
        for (const [key, value] of Object.entries(inputs)) {
            fixture.componentRef.setInput(key, value);
        }
        fixture.detectChanges();
        return fixture;
    }

    it('renders a Twemoji image and the count', () => {
        const root = create({ emoji: '👍', count: 3 }).nativeElement as HTMLElement;
        expect(root.querySelector('.reaction-emoji img')).not.toBeNull();
        expect(root.querySelector('.reaction-count')?.textContent?.trim()).toBe('3');
    });

    it('marks my own reaction and emits when pressed', () => {
        const fixture = create({ emoji: '❤️', count: 1, mine: true });
        let clicks = 0;
        fixture.componentInstance.chipClick.subscribe(() => clicks++);
        const pill = (fixture.nativeElement as HTMLElement).querySelector('.reaction-pill') as HTMLButtonElement;
        expect(pill.classList.contains('is-mine')).toBeTrue();
        expect(pill.getAttribute('aria-pressed')).toBe('true');
        pill.click();
        expect(clicks).toBe(1);
    });

    it('a preview chip looks the same but cannot be pressed', () => {
        const fixture = create({ emoji: '👍', interactive: false });
        const pill = (fixture.nativeElement as HTMLElement).querySelector('.reaction-pill') as HTMLButtonElement;
        expect(pill.disabled).toBeTrue();
        expect(getComputedStyle(pill).opacity).toBe('1');
    });

    it('is coloured from the chat chip variables', () => {
        const fixture = create({ emoji: '👍' });
        const root = fixture.nativeElement as HTMLElement;
        document.body.appendChild(root);
        const pill = root.querySelector('.reaction-pill') as HTMLElement;
        pill.style.transition = 'none';
        root.style.setProperty('--chat-chip-bg', 'rgb(1 2 3)');
        expect(getComputedStyle(pill).backgroundColor).toBe('rgb(1, 2, 3)');
        root.remove();
    });
});
