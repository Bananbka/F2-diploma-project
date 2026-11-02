import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { LucideAngularModule, Smile } from 'lucide-angular';

import { EmojiPickerComponent } from '../emoji-picker/emoji-picker.component';
import { insertAtCaret, TextControl } from './insert-at-caret';

/**
 * A small smiley button that opens the shared emoji picker and inserts the chosen emoji, as plain
 * Unicode, at the caret of `target`. Place it next to the field inside an `.emoji-input-wrap`
 * (global style) and pass the field's template reference: `<app-emoji-button [target]="field" />`.
 */
@Component({
    selector: 'app-emoji-button',
    imports: [LucideAngularModule, EmojiPickerComponent],
    template: `
        <button
            type="button"
            class="emoji-trigger trigger"
            aria-haspopup="dialog"
            [attr.aria-expanded]="open()"
            aria-label="Insert emoji"
            title="Insert emoji"
            (click)="open.set(!open())"
        >
            <lucide-icon [img]="icon" />
        </button>
        @if (open()) {
            <app-emoji-picker
                (closeRequested)="open.set(false)"
                (pick)="onPick($event)"
            />
        }
    `,
    styleUrl: './emoji-button.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmojiButtonComponent {
    readonly target = input.required<TextControl | null | undefined>();

    readonly open = signal(false);
    readonly icon = Smile;

    onPick(emoji: string): void {
        const control = this.target();
        if (!control) {
            return;
        }
        insertAtCaret(control, emoji);
        control.focus();
    }
}
