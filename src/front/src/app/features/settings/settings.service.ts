import { computed, inject, Injectable, signal } from '@angular/core';

import { ConfirmService } from '../../shared/ui/confirm-dialog/confirm.service';

export type SettingsTab = 'profile' | 'security' | 'stickers' | 'appearance' | 'privacy';

export const SETTINGS_TABS: readonly { id: SettingsTab; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'security', label: 'Security' },
    { id: 'stickers', label: 'Stickers' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'privacy', label: 'Privacy & data' },
];

/** Resolve a deep-link segment (including the retired page names) to a tab. */
export function tabFromSegment(segment: string | null | undefined): SettingsTab {
    switch (segment) {
        case 'security':
        case 'password':
            return 'security';
        case 'stickers':
            return 'stickers';
        case 'appearance':
            return 'appearance';
        case 'privacy':
            return 'privacy';
        default:
            return 'profile';
    }
}

/**
 * State of the settings dialog, which is mounted once in the app root.
 *
 * Lives in a service rather than a route so the dialog can sit over whatever the user was doing —
 * an open conversation keeps its place — and so the `/settings/*` deep links can open it without
 * replacing the page behind it.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
    private readonly confirm = inject(ConfirmService);

    readonly activeTab = signal<SettingsTab | null>(null);
    readonly isOpen = computed(() => this.activeTab() !== null);

    private opener: HTMLElement | null = null;
    private readonly dirtyChecks = new Set<() => boolean>();

    /** Open on `tab`, remembering where focus should go back to. A no-op for the opener if already open. */
    open(tab: SettingsTab = 'profile', opener?: HTMLElement | null): void {
        if (!this.isOpen()) {
            const active = document.activeElement;
            this.opener = opener ?? (active instanceof HTMLElement && active !== document.body ? active : null);
            this.activeTab.set(tab);
            return;
        }
        void this.select(tab);
    }

    /** Switch tab, asking first if the one being left has unsaved edits. */
    async select(tab: SettingsTab): Promise<boolean> {
        if (this.activeTab() === tab) {
            return true;
        }
        if (!(await this.confirmDiscard())) {
            return false;
        }
        this.activeTab.set(tab);
        return true;
    }

    /** Close, asking first if there are unsaved edits. Resolves to whether it closed. */
    async requestClose(): Promise<boolean> {
        if (!this.isOpen()) {
            return true;
        }
        if (!(await this.confirmDiscard())) {
            return false;
        }
        this.close();
        return true;
    }

    /** Close unconditionally (sign-out, session loss, account deletion) and return focus. */
    close(): void {
        if (!this.isOpen()) {
            return;
        }
        this.activeTab.set(null);
        this.dirtyChecks.clear();
        const opener = this.opener;
        this.opener = null;
        // A cold-load deep link has no opener; the rail's Settings button is the stable place to land.
        const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-settings-trigger]');
        if (target) {
            // After the dialog has left the DOM, so the trap cannot pull focus back.
            queueMicrotask(() => target.focus({ preventScroll: true }));
        }
    }

    /** A tab with editable state registers how to tell if it has unsaved changes. Returns the unregister. */
    registerDirtyCheck(check: () => boolean): () => void {
        this.dirtyChecks.add(check);
        return () => this.dirtyChecks.delete(check);
    }

    hasUnsavedChanges(): boolean {
        return [...this.dirtyChecks].some((check) => check());
    }

    private async confirmDiscard(): Promise<boolean> {
        if (!this.hasUnsavedChanges()) {
            return true;
        }
        return this.confirm.ask({
            title: 'Discard changes?',
            message: 'You have unsaved changes. If you leave now they will be lost.',
            confirmLabel: 'Discard',
            danger: true,
        });
    }
}
