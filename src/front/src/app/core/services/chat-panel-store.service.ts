import { Injectable, Signal, signal } from '@angular/core';

import { Sticker } from '../models/sticker.model';

export type ChatPanelTab = 'profile' | 'stickers' | 'emoji';

export const CHAT_PANEL_TABS: readonly ChatPanelTab[] = ['profile', 'stickers', 'emoji'];

const STORAGE_KEY = 'chat-panel-open';

/**
 * What the composer exposes to the side panel.
 *
 * The panel and the composer are siblings in different components, so the panel cannot reach the
 * composer's textarea (and must not try: DOM lookups would bypass the composer's own guards). The
 * composer registers this object instead, and every guard it applies to its own toolbar buttons
 * lives behind these methods, so the panel cannot do anything the composer would refuse.
 */
export interface ComposerBridge {
    /** Null when composing is possible; otherwise the reason it is not, in words for the user. */
    readonly unavailableReason: Signal<string | null>;
    /** Insert at the caret. Returns false (and changes nothing) when the composer refuses. */
    insertEmoji(emoji: string): boolean;
    /** Send immediately, as the composer's own sticker tray does. False when refused. */
    sendSticker(sticker: Sticker): boolean;
}

/**
 * State for the conversation's right-hand side panel, plus the bridge to the live composer.
 *
 * Whether the panel is open is remembered across reloads in localStorage. That is a pure UI
 * preference with no security weight, so unlike the trust store it is fine to lose; storage access
 * is wrapped because it throws in private modes and when storage is disabled.
 */
@Injectable({ providedIn: 'root' })
export class ChatPanelStoreService {
    readonly open = signal(readStoredOpen());
    readonly tab = signal<ChatPanelTab>('profile');
    /** The composer currently on screen, if any. There is at most one. */
    readonly composer = signal<ComposerBridge | null>(null);

    toggle(): void {
        this.setOpen(!this.open());
    }

    /** Open the panel on a given tab. */
    show(tab: ChatPanelTab): void {
        this.tab.set(tab);
        this.setOpen(true);
    }

    close(): void {
        this.setOpen(false);
    }

    selectTab(tab: ChatPanelTab): void {
        this.tab.set(tab);
    }

    registerComposer(bridge: ComposerBridge): void {
        this.composer.set(bridge);
    }

    /** Only clears if `bridge` is still the registered one, so a late teardown cannot evict a successor. */
    unregisterComposer(bridge: ComposerBridge): void {
        if (this.composer() === bridge) {
            this.composer.set(null);
        }
    }

    private setOpen(open: boolean): void {
        this.open.set(open);
        try {
            localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
        } catch {
            // Preference only; the panel still works for this session.
        }
    }
}

function readStoredOpen(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}
