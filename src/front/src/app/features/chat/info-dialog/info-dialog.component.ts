import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    inject,
    input,
    output,
    viewChild,
} from '@angular/core';
import { LucideAngularModule, X } from 'lucide-angular';

import { DismissOnEscapeDirective } from '../../../shared/ui/dismiss/dismiss-on-escape.directive';
import { trapTab } from '../../../shared/ui/focus-trap';
import { ChatInfoComponent } from '../chat-info/chat-info.component';

/**
 * Chat info as a centred dialog over the chat shell: the same component the side panel embeds, in
 * a card with a backdrop, a focus trap and Escape handled through the dismiss stack. Escape inside
 * a member profile goes back one level first (the info component stops that event itself).
 */
@Component({
    selector: 'app-info-dialog',
    imports: [LucideAngularModule, ChatInfoComponent, DismissOnEscapeDirective],
    templateUrl: './info-dialog.component.html',
    styleUrl: './info-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InfoDialogComponent {
    readonly chatId = input.required<string>();
    readonly closed = output<void>();

    readonly closeIcon = X;
    private readonly dialog = viewChild.required<ElementRef<HTMLElement>>('dialog');
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

    constructor() {
        afterNextRender(() => this.dialog().nativeElement.focus());
    }

    onKeydown(event: KeyboardEvent): void {
        trapTab(event, this.host.nativeElement);
    }
}
