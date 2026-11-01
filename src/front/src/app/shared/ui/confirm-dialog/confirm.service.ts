import { Injectable, signal } from '@angular/core';

export interface ConfirmRequest {
    title: string;
    message: string;
    confirmLabel: string;
    /** Styles the confirm button as destructive. */
    danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
    id: number;
    resolve: (answer: boolean) => void;
    /** Where focus returns afterwards. */
    opener: HTMLElement | null;
}

/**
 * A promise-shaped confirmation, rendered by `ConfirmDialogHostComponent`.
 *
 * Used for actions a menu click should not be able to trigger by accident (clear history, leave,
 * delete). One at a time: asking again while one is open cancels the first.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
    private nextId = 0;

    readonly pending = signal<PendingConfirm | null>(null);

    ask(request: ConfirmRequest): Promise<boolean> {
        this.pending()?.resolve(false);
        const active = document.activeElement;

        return new Promise<boolean>((resolve) => {
            this.pending.set({
                ...request,
                id: this.nextId++,
                resolve,
                opener: active instanceof HTMLElement && active !== document.body ? active : null,
            });
        });
    }

    answer(answer: boolean): void {
        const current = this.pending();
        if (!current) {
            return;
        }
        this.pending.set(null);
        current.resolve(answer);
        if (current.opener?.isConnected) {
            current.opener.focus({ preventScroll: true });
        }
    }
}
