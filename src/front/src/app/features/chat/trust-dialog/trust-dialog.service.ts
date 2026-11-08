import { inject, Injectable, signal } from '@angular/core';

import { InfoDialogService } from '../info-dialog/info-dialog.service';

/** Which chat's encryption/trust dialog is open over the chat shell, if any. */
@Injectable({ providedIn: 'root' })
export class TrustDialogService {
    private readonly info = inject(InfoDialogService);

    readonly chatId = signal<string | null>(null);

    open(chatId: string): void {
        this.chatId.set(chatId);
    }

    /**
     * What the shield opens. A group or channel has no single safety number, so it gets its encryption
     * status (with a way into each member's number); only a private chat has exactly one person to
     * compare with, and opens that person's number directly.
     */
    openSecurity(
        chat: { id: string; chat_type: string; participants: { user_id: string }[] },
        meId: string | undefined
    ): void {
        const peer = chat.participants.find((p) => p.user_id !== meId);
        if (chat.chat_type === 'private' && peer) {
            this.info.openSafety(chat.id, peer.user_id);
        } else {
            this.open(chat.id);
        }
    }

    close(): void {
        this.chatId.set(null);
    }
}
