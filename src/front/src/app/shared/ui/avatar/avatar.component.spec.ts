import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AvatarComponent } from './avatar.component';

describe('AvatarComponent', () => {
    let fixture: ComponentFixture<AvatarComponent>;

    function render(inputs: Record<string, unknown>): HTMLElement {
        fixture = TestBed.createComponent(AvatarComponent);
        for (const [key, value] of Object.entries(inputs)) {
            fixture.componentRef.setInput(key, value);
        }
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    const face = (host: HTMLElement) => host.querySelector<HTMLElement>('.monogram')!;

    it('gives a group the same coloured circle as a person, with letters from its words', () => {
        const group = render({ name: 'Game night', kind: 'group', seed: 'chat-1' });
        expect(face(group).textContent?.trim()).toBe('GN');
        expect(face(group).style.backgroundColor).not.toBe('');
        expect(group.querySelector('lucide-icon')).toBeNull();

        const person = render({ name: 'Ada Lovelace', seed: 'user-1' });
        expect(face(person).textContent?.trim()).toBe('AL');
        expect(face(person).style.backgroundColor).not.toBe('');
    });

    it('follows --chat-font-scale only when scaled', () => {
        const unscaled = render({ name: 'Ada Lovelace', size: 'sm' });
        const scaled = render({ name: 'Ada Lovelace', size: 'sm', scaled: true });
        for (const el of [unscaled, scaled]) {
            document.body.appendChild(el);
        }
        const baseWidth = parseFloat(getComputedStyle(unscaled).width);
        const baseFont = parseFloat(getComputedStyle(face(scaled)).fontSize);
        for (const el of [unscaled, scaled]) {
            el.style.setProperty('--chat-font-scale', '2');
        }
        expect(parseFloat(getComputedStyle(unscaled).width)).toBeCloseTo(baseWidth, 1);
        expect(parseFloat(getComputedStyle(scaled).width)).toBeCloseTo(baseWidth * 2, 1);
        expect(parseFloat(getComputedStyle(face(scaled)).fontSize)).toBeCloseTo(baseFont * 2, 1);
        unscaled.remove();
        scaled.remove();
    });

    it('derives a stable colour from the seed, not the title', () => {
        const a = render({ name: 'Old name', kind: 'group', seed: 'chat-1' });
        const before = face(a).style.backgroundColor;
        const b = render({ name: 'Renamed', kind: 'group', seed: 'chat-1' });
        expect(face(b).style.backgroundColor).toBe(before);
    });

    it('does not treat a # name as a channel icon any more', () => {
        const host = render({ name: '#general', kind: 'channel', seed: 'c' });
        expect(face(host).textContent?.trim()).toBe('G');
        expect(host.querySelector('lucide-icon')).toBeNull();
    });

    it('falls back to an icon only when the title has no letters', () => {
        const group = render({ name: '###', kind: 'group', seed: 'c' });
        expect(group.querySelector('lucide-icon')).not.toBeNull();
        expect(face(group).textContent?.trim()).toBe('');

        const channel = render({ name: '', kind: 'channel', seed: 'c' });
        expect(channel.querySelector('lucide-icon')).not.toBeNull();
    });

    it('falls back to the monogram when the picture fails to load', () => {
        const host = render({ name: 'string', kind: 'group', seed: 'c', imageUrl: 'string' });
        host.querySelector('img.face')!.dispatchEvent(new Event('error'));
        fixture.detectChanges();
        expect(host.querySelector('img')).toBeNull();
        expect(face(host).textContent?.trim()).toBe('S');
    });

    it('shows the picture when there is one', () => {
        const host = render({ name: 'Team', kind: 'group', seed: 'c', imageUrl: 'https://x.test/a.png' });
        expect(host.querySelector('img.face')).not.toBeNull();
        expect(host.querySelector('.monogram')).toBeNull();
    });
});
