import { inject, Injectable, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

export type CreateDialogKind = 'group' | 'channel';

/**
 * Which "new group / new channel" dialog is open over the chat shell, if any.
 *
 * These used to be full-screen routes. They are dialogs now, so the open state lives here: the
 * sidebar menu opens one, the shell renders it, and the deep links (`/new/group`, `/new/channel`)
 * open it through `createDialogDeepLinkGuard`.
 */
@Injectable({ providedIn: 'root' })
export class CreateDialogService {
    readonly open = signal<CreateDialogKind | null>(null);

    show(kind: CreateDialogKind): void {
        this.open.set(kind);
    }

    close(): void {
        this.open.set(null);
    }
}

/** Same behaviour as the settings deep-link guard: open the dialog, then sit on the chat shell. */
const SHELL_URL = /^\/(chats(\/|\?|#|$)|\?|#|$)/;

export const createDialogDeepLinkGuard: CanActivateFn = (route) => {
    const dialogs = inject(CreateDialogService);
    const router = inject(Router);

    dialogs.show(route.data['kind'] === 'channel' ? 'channel' : 'group');

    return router.navigated && SHELL_URL.test(router.url) ? false : router.parseUrl('/chats');
};
