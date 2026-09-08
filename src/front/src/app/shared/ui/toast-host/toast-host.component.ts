import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LucideAngularModule, X } from 'lucide-angular';

import { ToastService } from '../../../core/services/toast.service';

@Component({
    selector: 'app-toast-host',
    imports: [LucideAngularModule],
    template: `
        <div
            class="stack"
            aria-live="polite"
        >
            @for (toast of toasts(); track toast.id) {
                <div
                    class="toast"
                    [class.is-error]="toast.tone === 'error'"
                    [attr.role]="toast.tone === 'error' ? 'alert' : 'status'"
                >
                    <span>{{ toast.message }}</span>
                    <button
                        type="button"
                        aria-label="Dismiss"
                        (click)="dismiss(toast.id)"
                    >
                        <lucide-icon [img]="closeIcon" />
                    </button>
                </div>
            }
        </div>
    `,
    styles: `
        .stack {
            position: fixed;
            right: 1rem;
            bottom: 1rem;
            z-index: 80;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
            max-width: min(24rem, calc(100vw - 2rem));
        }

        .toast {
            display: flex;
            align-items: flex-start;
            gap: 0.75rem;
            padding: 0.75rem 0.875rem;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-lg);
            box-shadow: 0 16px 40px rgb(0 0 0 / 45%);
            color: var(--foreground);
            font-size: 0.8125rem;
            line-height: 1.5;

            &.is-error {
                background: var(--danger-surface);
                border-color: var(--danger-border);
                color: var(--danger-strong);
            }

            button {
                flex-shrink: 0;
                padding: 0;
                background: none;
                border: none;
                color: inherit;
                opacity: 0.7;

                &:hover {
                    opacity: 1;
                }
            }

            lucide-icon {
                width: 0.875rem;
                height: 0.875rem;
            }
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastHostComponent {
    private readonly toastService = inject(ToastService);

    readonly toasts = this.toastService.toasts;
    readonly closeIcon = X;

    dismiss(id: number): void {
        this.toastService.dismiss(id);
    }
}
