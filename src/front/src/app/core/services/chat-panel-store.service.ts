import { Injectable, Signal, signal } from '@angular/core';

import { Sticker } from '../models/sticker.model';

/** The panel is one column with two modes: the conversation's info, or the emoji/sticker picker. */
export type ChatPanelView = 'profile' | 'picker';
export type PickerTab = 'emoji' | 'stickers';

export const PICKER_TABS: readonly PickerTab[] = ['emoji', 'stickers'];

const OPEN_KEY = 'chat-panel-open';
const VIEW_KEY = 'chat-panel-view';
const PICKER_TAB_KEY = 'chat-panel-picker-tab';

/** What the chat-info view was showing for one chat, so a route round-trip can put it back. */
export interface InfoPanelState {
    tab: 'main' | 'encryption' | 'settings' | 'data';
    memberId: string | null;
    /** The member's safety number is open inline in place of their profile. */
    safetyOpen: boolean;
}

/** Matches the breakpoint where the panel becomes a slide-over covering the conversation. */
const OVERLAY_QUERY = '(width < 72rem)';

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
    /** Send immediately, with no staging step. False when refused. */
    sendSticker(sticker: Sticker): boolean;
}

/**
 * State for the conversation's right-hand side panel, plus the bridge to the live composer.
 *
 * One panel, two views: `profile` (chat info, opened from the conversation header) and `picker`
 * (Emoji / Stickers tabs, opened from the composer's smiley button). Each entry point toggles its
 * own view: pressing it while the panel shows the other view switches rather than closes.
 *
 * Open state, view and picker tab are remembered in localStorage. That is a pure UI preference with
 * no security weight, so unlike the trust store it is fine to lose; storage access is wrapped
 * because it throws in private modes and when storage is disabled. A remembered "open" is not
 * restored on a narrow screen, where the panel is a slide-over that would cover the conversation on
 * every load.
 */
@Injectable({ providedIn: 'root' })
export class ChatPanelStoreService {
    readonly open = signal(readStoredOpen());
    readonly view = signal<ChatPanelView>(readStored(VIEW_KEY, ['profile', 'picker'], 'picker'));
    readonly pickerTab = signal<PickerTab>(readStored(PICKER_TAB_KEY, PICKER_TABS, 'emoji'));
    /** The composer currently on screen, if any. There is at most one. */
    readonly composer = signal<ComposerBridge | null>(null);

    /**
     * Chat-info state per chat id. In memory only: it has to survive navigating to another route and
     * back within the session (the component is destroyed on the way), not a reload.
     */
    private readonly infoStates = new Map<string, InfoPanelState>();

    infoState(chatId: string): InfoPanelState | null {
        return this.infoStates.get(chatId) ?? null;
    }

    saveInfoState(chatId: string, state: InfoPanelState): void {
        this.infoStates.set(chatId, state);
    }

    /** Header entry point: show chat info, or close the panel if it is already showing it. */
    toggleProfile(): void {
        this.toggleView('profile');
    }

    /** Composer entry point: show the emoji/sticker picker, or close the panel if already showing it. */
    togglePicker(): void {
        this.toggleView('picker');
    }

    showProfile(): void {
        this.setView('profile');
        this.setOpen(true);
    }

    /** Open on the picker, optionally on a given tab (otherwise the one last used). */
    showPicker(tab?: PickerTab): void {
        if (tab) {
            this.selectPickerTab(tab);
        }
        this.setView('picker');
        this.setOpen(true);
    }

    close(): void {
        this.setOpen(false);
    }

    selectPickerTab(tab: PickerTab): void {
        this.pickerTab.set(tab);
        store(PICKER_TAB_KEY, tab);
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

    private toggleView(view: ChatPanelView): void {
        if (this.open() && this.view() === view) {
            this.setOpen(false);
            return;
        }
        this.setView(view);
        this.setOpen(true);
    }

    private setView(view: ChatPanelView): void {
        this.view.set(view);
        store(VIEW_KEY, view);
    }

    private setOpen(open: boolean): void {
        this.open.set(open);
        store(OPEN_KEY, open ? '1' : '0');
    }
}

function store(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Preference only; the panel still works for this session.
    }
}

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    try {
        const value = localStorage.getItem(key);
        return allowed.find((candidate) => candidate === value) ?? fallback;
    } catch {
        return fallback;
    }
}

function readStoredOpen(): boolean {
    try {
        if (localStorage.getItem(OPEN_KEY) !== '1') {
            return false;
        }
        return !window.matchMedia(OVERLAY_QUERY).matches;
    } catch {
        return false;
    }
}
