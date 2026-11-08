import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { LucideAngularModule, MapPin, X } from 'lucide-angular';

import {
    formatCoordinates,
    LOCATION_LABEL_MAX,
    LocationPayload,
    validateLocation,
} from '../../../core/models/message-payload';
import { GEOLOCATION_MESSAGES, requestPosition } from '../../../core/services/geolocation';
import { DismissOnEscapeDirective } from '../../../shared/ui/dismiss/dismiss-on-escape.directive';

type Phase = 'idle' | 'locating' | 'ready' | 'error';

/**
 * Share the current location. Nothing is requested until the user presses the button, the browser
 * shows its own permission prompt, and the result is previewed before anything is sent.
 */
@Component({
    selector: 'app-location-dialog',
    imports: [DismissOnEscapeDirective, LucideAngularModule],
    templateUrl: './location-dialog.component.html',
    styleUrl: './location-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocationDialogComponent {
    /** Why sending is impossible right now, or null. Re-checked by the composer on submit too. */
    readonly blockedReason = input<string | null>(null);

    readonly submitted = output<LocationPayload>();
    readonly closed = output<void>();

    readonly phase = signal<Phase>('idle');
    readonly error = signal<string | null>(null);
    readonly fix = signal<LocationPayload | null>(null);
    readonly label = signal('');

    readonly labelMax = LOCATION_LABEL_MAX;
    readonly closeIcon = X;
    readonly pinIcon = MapPin;

    readonly coordinates = computed(() => {
        const fix = this.fix();
        return fix ? formatCoordinates(fix.lat, fix.lon) : null;
    });

    readonly canSend = computed(() => this.phase() === 'ready' && this.fix() !== null && !this.blockedReason());

    /** Always an explicit user action: this is bound to a button, never to dialog open. */
    async locate(): Promise<void> {
        if (this.phase() === 'locating') {
            return;
        }
        this.phase.set('locating');
        this.error.set(null);

        const result = await requestPosition();
        if (result.ok) {
            this.fix.set(result.location);
            this.phase.set('ready');
        } else {
            this.fix.set(null);
            this.error.set(GEOLOCATION_MESSAGES[result.reason]);
            this.phase.set('error');
        }
    }

    send(): void {
        const fix = this.fix();
        if (!fix || !this.canSend()) {
            return;
        }
        try {
            this.submitted.emit(validateLocation({ ...fix, label: this.label() }));
        } catch {
            this.error.set(GEOLOCATION_MESSAGES.invalid);
            this.phase.set('error');
        }
    }
}
