import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Lock, LucideAngularModule } from 'lucide-angular';

/** The product lockup from the design: a rounded primary tile with a padlock. */
@Component({
    selector: 'app-brand-mark',
    imports: [LucideAngularModule],
    template: `
        <span class="tile">
            <lucide-icon [img]="lockIcon" />
        </span>
        @if (showName()) {
            <span class="name">Mess&amp;Gags</span>
        }
    `,
    styles: `
        :host {
            display: inline-flex;
            align-items: center;
            gap: 0.625rem;
        }

        .tile {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2.25rem;
            height: 2.25rem;
            background: var(--primary);
            border-radius: var(--radius-lg);
            color: #fff;

            lucide-icon {
                width: 1.25rem;
                height: 1.25rem;
            }
        }

        .name {
            color: var(--foreground);
            font-size: 1.125rem;
            font-weight: 600;
            letter-spacing: -0.01em;
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandMarkComponent {
    readonly showName = input(true);
    readonly lockIcon = Lock;
}
