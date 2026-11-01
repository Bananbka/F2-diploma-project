import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LucideAngularModule, ShieldCheck } from 'lucide-angular';

import { ChangePasswordComponent } from '../change-password/change-password.component';
import { DevicesComponent } from '../devices/devices.component';

/** The Security tab: password, devices and the prekey, plus a pointer to safety numbers. */
@Component({
    selector: 'app-security',
    imports: [LucideAngularModule, ChangePasswordComponent, DevicesComponent],
    template: `
        <app-change-password />
        <app-devices />

        <p class="notice">
            <lucide-icon [img]="shieldIcon" />
            <span>
                To check that nobody has swapped a contact's keys, compare safety numbers: open a conversation and use
                the shield in the left rail.
            </span>
        </p>
    `,
    styles: `
        :host {
            display: block;
        }

        app-devices {
            display: block;
            margin-top: 1rem;
        }

        .notice {
            display: flex;
            align-items: flex-start;
            gap: 0.625rem;
            margin: 1.5rem 0 0;
            padding: 0.875rem;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-lg);
            color: var(--muted-foreground);
            font-size: 0.75rem;
            line-height: 1.55;
        }

        lucide-icon {
            flex-shrink: 0;
            width: 1rem;
            height: 1rem;
            margin-top: 0.125rem;
            color: var(--primary);
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SecurityComponent {
    readonly shieldIcon = ShieldCheck;
}
