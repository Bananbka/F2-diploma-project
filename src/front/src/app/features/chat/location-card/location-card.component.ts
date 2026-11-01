import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ExternalLink, LucideAngularModule, MapPin } from 'lucide-angular';

import {
    formatCoordinates,
    isValidLatitude,
    isValidLongitude,
    LocationPayload,
    openStreetMapUrl,
} from '../../../core/models/message-payload';

/**
 * A shared location, as text and one outbound link.
 *
 * Deliberately not a map: embedding tiles would send every viewer's IP and the coordinates to a third
 * party the moment the message scrolled into view. The link only does that when the user follows it.
 * The coordinates are range-checked again here even though the payload was validated on receipt.
 */
@Component({
    selector: 'app-location-card',
    imports: [LucideAngularModule],
    templateUrl: './location-card.component.html',
    styleUrl: './location-card.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocationCardComponent {
    readonly location = input.required<LocationPayload>();
    /** False during a bulk selection, where a click must pick the message rather than navigate away. */
    readonly interactive = input(true);

    readonly valid = computed(() => {
        const { lat, lon } = this.location();
        return isValidLatitude(lat) && isValidLongitude(lon);
    });

    readonly coordinates = computed(() => {
        const { lat, lon } = this.location();
        return this.valid() ? formatCoordinates(lat, lon) : null;
    });

    readonly accuracy = computed(() => {
        const meters = this.location().accuracy;
        if (meters === null || meters === undefined) {
            return null;
        }
        return meters >= 1000 ? `±${(meters / 1000).toFixed(1)} km` : `±${Math.round(meters)} m`;
    });

    readonly mapUrl = computed(() => {
        const { lat, lon } = this.location();
        return openStreetMapUrl(lat, lon);
    });

    readonly pinIcon = MapPin;
    readonly externalIcon = ExternalLink;
}
