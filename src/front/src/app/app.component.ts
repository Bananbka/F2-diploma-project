import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, signal, Type, untracked } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { ToastService } from './core/services/toast.service';
import { StickerPackViewerHostComponent } from './features/chat/stickers/sticker-pack-dialog/sticker-pack-viewer';
import { SettingsService } from './features/settings/settings.service';
import { SETTINGS_MODAL_LOADER } from './features/settings/settings-modal.loader';
import { ConfirmDialogHostComponent } from './shared/ui/confirm-dialog/confirm-dialog-host.component';
import { ContextMenuHostComponent } from './shared/ui/context-menu/context-menu-host.component';
import { ToastHostComponent } from './shared/ui/toast-host/toast-host.component';

@Component({
    selector: 'app-root',
    imports: [
        RouterOutlet,
        ToastHostComponent,
        ContextMenuHostComponent,
        ConfirmDialogHostComponent,
        StickerPackViewerHostComponent,
        NgComponentOutlet,
    ],
    templateUrl: './app.component.html',
    styleUrl: './app.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
    protected readonly settings = inject(SettingsService);
    private readonly loadSettingsModal = inject(SETTINGS_MODAL_LOADER);
    private readonly toast = inject(ToastService);

    /** The settings dialog, fetched on first use so it stays out of the main bundle. */
    protected readonly settingsComponent = signal<Type<unknown> | null>(null);
    private loading = false;

    constructor() {
        effect(() => {
            if (this.settings.isOpen() && !this.settingsComponent()) {
                untracked(() => void this.fetchSettings());
            }
        });
    }

    /**
     * If the chunk cannot be downloaded the open state is reset, so the Settings button simply tries
     * again next time rather than leaving an invisible dialog "open" that nothing can dismiss.
     */
    private async fetchSettings(): Promise<void> {
        if (this.loading) {
            return;
        }
        this.loading = true;
        try {
            this.settingsComponent.set(await this.loadSettingsModal());
        } catch {
            this.settings.close();
            this.toast.error('Could not load settings. Check your connection and try again.');
        } finally {
            this.loading = false;
        }
    }
}
