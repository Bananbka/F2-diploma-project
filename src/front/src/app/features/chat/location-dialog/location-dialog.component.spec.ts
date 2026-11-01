import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LocationPayload } from '../../../core/models/message-payload';
import { LocationDialogComponent } from './location-dialog.component';

type Success = (position: GeolocationPosition) => void;
type Failure = (error: GeolocationPositionError) => void;

describe('LocationDialogComponent', () => {
    let fixture: ComponentFixture<LocationDialogComponent>;
    let getCurrentPosition: jasmine.Spy;

    function mockGeolocation(behaviour: (ok: Success, fail: Failure) => void): void {
        getCurrentPosition = jasmine.createSpy('getCurrentPosition').and.callFake(behaviour);
        spyOnProperty(navigator, 'geolocation', 'get').and.returnValue({
            getCurrentPosition,
        } as unknown as Geolocation);
    }

    const fix = (lat: number, lon: number) =>
        ({ coords: { latitude: lat, longitude: lon, accuracy: 30 } }) as GeolocationPosition;

    function create(): HTMLElement {
        fixture = TestBed.createComponent(LocationDialogComponent);
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    async function press(host: HTMLElement, label: string): Promise<void> {
        const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
            b.textContent!.includes(label)
        )!;
        button.click();
        await fixture.whenStable();
        fixture.detectChanges();
    }

    beforeEach(() => TestBed.configureTestingModule({ imports: [LocationDialogComponent] }));

    it('asks for nothing until the user presses the button', () => {
        mockGeolocation(() => undefined);
        create();
        expect(getCurrentPosition).not.toHaveBeenCalled();
    });

    it('previews the coordinates, then sends them with the label', async () => {
        mockGeolocation((ok) => ok(fix(50.4501234, 30.5234567)));
        const host = create();
        const sent: LocationPayload[] = [];
        fixture.componentInstance.submitted.subscribe((l) => sent.push(l));

        await press(host, 'Use my current location');
        expect(host.querySelector('.coords')!.textContent).toContain('50.45012, 30.52346');

        fixture.componentInstance.label.set('Cafe');
        await press(host, 'Send');

        expect(sent).toEqual([{ lat: 50.450123, lon: 30.523457, accuracy: 30, label: 'Cafe' }]);
    });

    const outcomes: [string, number, string][] = [
        ['denied', 1, 'denied'],
        ['unavailable', 2, 'could not be determined'],
        ['timeout', 3, 'took too long'],
    ];
    for (const [name, code, text] of outcomes) {
        it(`explains a ${name} outcome and does not retry by itself`, async () => {
            mockGeolocation((_, fail) => fail({ code } as GeolocationPositionError));
            const host = create();

            await press(host, 'Use my current location');

            expect(host.querySelector('.error')!.textContent).toContain(text);
            expect(getCurrentPosition).toHaveBeenCalledTimes(1);
            expect(host.textContent).toContain('Try again');
        });
    }

    it('says so when the browser has no geolocation', async () => {
        spyOnProperty(navigator, 'geolocation', 'get').and.returnValue(undefined as never);
        const host = create();
        await press(host, 'Use my current location');
        expect(host.querySelector('.error')!.textContent).toContain('does not offer location access');
    });

    it('refuses to send while sending is blocked', async () => {
        mockGeolocation((ok) => ok(fix(1, 2)));
        const host = create();
        fixture.componentRef.setInput('blockedReason', 'Blocked.');
        const sent: LocationPayload[] = [];
        fixture.componentInstance.submitted.subscribe((l) => sent.push(l));

        await press(host, 'Use my current location');
        fixture.componentInstance.send();

        expect(sent).toEqual([]);
        expect(host.textContent).toContain('Blocked.');
    });
});
