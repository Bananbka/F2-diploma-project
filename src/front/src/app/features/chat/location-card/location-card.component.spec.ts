import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LocationPayload } from '../../../core/models/message-payload';
import { LocationCardComponent } from './location-card.component';

describe('LocationCardComponent', () => {
    let fixture: ComponentFixture<LocationCardComponent>;

    function create(location: LocationPayload, interactive = true): HTMLElement {
        TestBed.configureTestingModule({ imports: [LocationCardComponent] });
        fixture = TestBed.createComponent(LocationCardComponent);
        fixture.componentRef.setInput('location', location);
        fixture.componentRef.setInput('interactive', interactive);
        fixture.detectChanges();
        return fixture.nativeElement;
    }

    it('shows rounded coordinates, the label and the accuracy', () => {
        const host = create({ lat: 50.450123, lon: 30.523457, accuracy: 12.4, label: 'Home' });
        expect(host.querySelector('.label')!.textContent).toContain('Home');
        expect(host.querySelector('.coords')!.textContent).toContain('50.45012, 30.52346');
        expect(host.querySelector('.accuracy')!.textContent).toContain('±12 m');
    });

    it('links to OpenStreetMap at six decimals, in a new tab, without referrer or opener', () => {
        const host = create({ lat: 50.450123, lon: 30.523457, accuracy: null, label: null });
        const link = host.querySelector<HTMLAnchorElement>('a.open')!;

        expect(link.href).toBe(
            'https://www.openstreetmap.org/?mlat=50.450123&mlon=30.523457#map=16/50.450123/30.523457'
        );
        expect(link.target).toBe('_blank');
        expect(link.rel).toBe('noopener noreferrer');
    });

    it('makes no request to a map provider on its own', () => {
        const host = create({ lat: 1, lon: 2, accuracy: null, label: null });
        expect(host.querySelector('img, iframe, script, link')).toBeNull();
    });

    it('does not offer the link during a bulk selection', () => {
        const host = create({ lat: 1, lon: 2, accuracy: null, label: null }, false);
        expect(host.querySelector('a')).toBeNull();
    });

    it('refuses to show out-of-range coordinates', () => {
        const host = create({ lat: 123, lon: 2, accuracy: null, label: null });
        expect(host.textContent).toContain('Invalid location');
        expect(host.querySelector('a')).toBeNull();
        expect(host.querySelector('.coords')).toBeNull();
    });

    it('shows a large accuracy in kilometres', () => {
        const host = create({ lat: 1, lon: 2, accuracy: 2500, label: null });
        expect(host.querySelector('.accuracy')!.textContent).toContain('±2.5 km');
    });
});
