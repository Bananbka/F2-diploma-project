import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { StickerPackViewerHostComponent } from './features/chat/stickers/sticker-pack-dialog/sticker-pack-viewer';
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
    ],
    templateUrl: './app.component.html',
    styleUrl: './app.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {}
