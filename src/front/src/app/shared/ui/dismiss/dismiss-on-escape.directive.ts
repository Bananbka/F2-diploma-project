import { DestroyRef, Directive, inject, output } from '@angular/core';

import { DismissStackService } from './dismiss-layer.service';

/**
 * Puts the host (a dialog, a drawer) on the Escape stack for as long as it exists, and emits
 * `appDismissOnEscape` when Escape reaches it as the topmost layer. Put it on the element that is
 * created and destroyed with the dialog, e.g. `<div role="dialog" (appDismissOnEscape)="closed.emit()">`.
 */
@Directive({
    selector: '[appDismissOnEscape]',
})
export class DismissOnEscapeDirective {
    readonly appDismissOnEscape = output<void>();

    constructor() {
        const remove = inject(DismissStackService).push({ close: () => this.appDismissOnEscape.emit() });
        inject(DestroyRef).onDestroy(remove);
    }
}
