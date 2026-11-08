import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    signal,
    viewChild,
} from '@angular/core';
import { Lock, LucideAngularModule, Palette, ShieldCheck, Sticker, User, X } from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';
import { trapTab } from '../../../shared/ui/focus-trap';
import { StickerPackManagerComponent } from '../../chat/stickers/sticker-pack-manager/sticker-pack-manager.component';
import { AppearanceComponent } from '../appearance/appearance.component';
import { PrivacyComponent } from '../privacy/privacy.component';
import { ProfileComponent } from '../profile/profile.component';
import { SecurityComponent } from '../security/security.component';
import { SETTINGS_TABS, SettingsService, SettingsTab } from '../settings.service';

/** Matches the full-screen breakpoint in the stylesheet. */
const NARROW_QUERY = '(width < 48rem)';

const TAB_ICONS = {
    profile: User,
    security: ShieldCheck,
    stickers: Sticker,
    appearance: Palette,
    privacy: Lock,
} as const;

/**
 * The settings dialog: a vertical tab list beside the active tab on wide screens, a scrollable tab
 * strip above it (and the whole dialog full-screen) on narrow ones.
 *
 * Mounted once from the app root and driven by `SettingsService`. Tabs use manual activation —
 * arrow keys move focus, Enter or Space selects — because leaving the Profile tab with unsaved edits
 * asks for confirmation, and a prompt on every arrow press would be unusable.
 */
@Component({
    selector: 'app-settings-modal',
    imports: [
        LucideAngularModule,
        ProfileComponent,
        SecurityComponent,
        StickerPackManagerComponent,
        AppearanceComponent,
        PrivacyComponent,
    ],
    templateUrl: './settings-modal.component.html',
    styleUrl: './settings-modal.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsModalComponent {
    protected readonly settings = inject(SettingsService);
    private readonly session = inject(SessionService);

    private readonly dialog = viewChild.required<ElementRef<HTMLElement>>('dialog');
    private readonly tablist = viewChild.required<ElementRef<HTMLElement>>('tablist');

    readonly tabs = SETTINGS_TABS.map((tab) => ({ ...tab, icon: TAB_ICONS[tab.id] }));
    readonly activeTab = this.settings.activeTab;
    readonly narrow = signal(window.matchMedia(NARROW_QUERY).matches);

    readonly closeIcon = X;

    constructor() {
        const media = window.matchMedia(NARROW_QUERY);
        const onChange = (event: MediaQueryListEvent) => this.narrow.set(event.matches);
        media.addEventListener('change', onChange);
        inject(DestroyRef).onDestroy(() => media.removeEventListener('change', onChange));

        // Nothing here makes sense without a signed-in user; leave if the session goes (sign-out,
        // an expired session, a deleted account).
        // A user that is null while the session is still being restored, or before the first one has
        // appeared, is not the session ending — only a user that goes away after having been there is.
        let seenUser = false;
        effect(() => {
            const user = this.session.user();
            if (user) {
                seenUser = true;
            } else if (seenUser && this.session.isRestored()) {
                this.settings.close();
            }
        });

        // Escape works wherever focus is while the dialog is open, not only inside the card. Inner
        // layers stop or prevent the event first, so this only sees what is meant for the dialog.
        const onDocumentKeydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault();
                this.close();
            }
        };
        document.addEventListener('keydown', onDocumentKeydown);
        inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', onDocumentKeydown));

        afterNextRender(() => this.focusTab(this.activeTab() ?? 'profile'));
    }

    tabId(tab: SettingsTab): string {
        return `settings-tab-${tab}`;
    }

    async select(tab: SettingsTab): Promise<void> {
        await this.settings.select(tab);
    }

    close(): void {
        void this.settings.requestClose();
    }

    onScrimClick(event: MouseEvent): void {
        // Only a click on the scrim itself, never one that started inside the card and ended up here.
        if (event.target === event.currentTarget) {
            this.close();
        }
    }

    onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            this.close();
        } else if (event.key === 'Tab') {
            trapTab(event, this.dialog().nativeElement);
        }
    }

    onTabKeydown(event: KeyboardEvent): void {
        const buttons = [...this.tablist().nativeElement.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (current < 0) {
            return;
        }

        let next = -1;
        switch (event.key) {
            case 'ArrowDown':
            case 'ArrowRight':
                next = (current + 1) % buttons.length;
                break;
            case 'ArrowUp':
            case 'ArrowLeft':
                next = (current - 1 + buttons.length) % buttons.length;
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = buttons.length - 1;
                break;
        }

        if (next >= 0) {
            event.preventDefault();
            buttons[next].focus();
        }
    }

    private focusTab(tab: SettingsTab): void {
        this.tablist()
            .nativeElement.querySelector<HTMLElement>(`#${this.tabId(tab)}`)
            ?.focus({ preventScroll: true });
    }
}
