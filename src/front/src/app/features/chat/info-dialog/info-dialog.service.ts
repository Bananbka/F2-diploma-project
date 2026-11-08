import { inject, Injectable, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { ChatPanelStoreService } from '../../../core/services/chat-panel-store.service';

/** Where the dialog may simply appear over the page the user is already on. */
const SHELL_URL = /^\/(chats(\/|\?|#|$)|\?|#|$)/;

/**
 * Which chat's info is open as a dialog over the chat shell, if any.
 *
 * Chat info used to be a full page (`/chats/:id/info`) and the safety number another. Both are the
 * same `ChatInfoComponent` the side panel shows, so the dialog embeds it and its remembered tab,
 * member and safety sub-view (kept per chat by `ChatPanelStoreService`) come back unchanged.
 */
@Injectable({ providedIn: 'root' })
export class InfoDialogService {
    private readonly panelStore = inject(ChatPanelStoreService);

    readonly chatId = signal<string | null>(null);

    open(chatId: string): void {
        this.chatId.set(chatId);
    }

    /** Open on a person's safety number: lands on their profile with the number showing. */
    openSafety(chatId: string, userId: string): void {
        this.panelStore.saveInfoState(chatId, { tab: 'main', memberId: userId, safetyOpen: true });
        this.chatId.set(chatId);
    }

    close(): void {
        this.chatId.set(null);
    }
}

/** Keep the user where they are when that already is this chat; otherwise go to the chat for the dialog to sit on. */
function stay(router: Router, chatId: string): boolean | ReturnType<Router['parseUrl']> {
    const onThisChat =
        router.navigated && SHELL_URL.test(router.url) && router.url.split(/[?#]/)[0] === `/chats/${chatId}`;
    return onThisChat ? false : router.parseUrl(`/chats/${chatId}`);
}

/** `/chats/:chatId/info` opens the dialog instead of a page. */
export const chatInfoDeepLinkGuard: CanActivateFn = (route) => {
    const chatId = route.params['chatId'] as string;
    inject(InfoDialogService).open(chatId);
    return stay(inject(Router), chatId);
};

/** `/chats/:chatId/safety/:userId` opens the dialog on that person's safety number. */
export const safetyDeepLinkGuard: CanActivateFn = (route) => {
    const chatId = route.params['chatId'] as string;
    inject(InfoDialogService).openSafety(chatId, route.params['userId'] as string);
    return stay(inject(Router), chatId);
};
