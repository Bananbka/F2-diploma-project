import { Injectable, signal } from '@angular/core';

export interface Toast {
    id: number;
    message: string;
    tone: 'error' | 'info';
}

const DISMISS_AFTER_MS = 6000;

/**
 * Transient notices for failures that happen outside a form.
 *
 * A form can put an error next to the field that caused it; a background action — a role change, a
 * folder update, a socket rejection — has nowhere to put one, and until now those failed silently.
 *
 * Deliberately not used for the security states. A member-set failure or a decrypt failure is a
 * property of the conversation, not an event: it must persist in place until it is resolved, not
 * scroll away after six seconds.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
    private nextId = 0;

    readonly toasts = signal<Toast[]>([]);

    error(message: string): void {
        this.push(message, 'error');
    }

    info(message: string): void {
        this.push(message, 'info');
    }

    dismiss(id: number): void {
        this.toasts.update((list) => list.filter((toast) => toast.id !== id));
    }

    private push(message: string, tone: Toast['tone']): void {
        const id = this.nextId++;
        this.toasts.update((list) => [...list, { id, message, tone }]);
        setTimeout(() => this.dismiss(id), DISMISS_AFTER_MS);
    }
}
