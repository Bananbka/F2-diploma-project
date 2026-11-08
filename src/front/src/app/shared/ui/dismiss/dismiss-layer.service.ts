import { Injectable } from '@angular/core';

export interface DismissLayer {
    /** Called when Escape is pressed while this is the topmost layer. */
    readonly close: () => void;
}

/**
 * A stack of things that Escape dismisses, innermost first.
 *
 * One document listener serves every layer, so Escape closes exactly one thing per press: the most
 * recently opened. Layers register while they are open (`appDismissOnEscape` does it for a dialog;
 * message selection mode registers directly). Popovers and menus that handle Escape themselves, in
 * the capture phase or on their own element, stop the event before it reaches the document, so they
 * close first without being on the stack; a handler that already `preventDefault`ed has consumed
 * the key and the stack leaves it alone. Components that already close on Escape by their own means
 * need not be migrated: they simply never push a layer.
 */
@Injectable({ providedIn: 'root' })
export class DismissStackService {
    private readonly layers: DismissLayer[] = [];

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || event.defaultPrevented) {
            return;
        }
        const top = this.layers[this.layers.length - 1];
        if (top) {
            event.preventDefault();
            top.close();
        }
    };

    get depth(): number {
        return this.layers.length;
    }

    /** Add a layer on top; returns the function that removes it. Removing twice is harmless. */
    push(layer: DismissLayer): () => void {
        if (this.layers.length === 0) {
            document.addEventListener('keydown', this.onKeyDown);
        }
        this.layers.push(layer);
        return () => {
            const index = this.layers.indexOf(layer);
            if (index === -1) {
                return;
            }
            this.layers.splice(index, 1);
            if (this.layers.length === 0) {
                document.removeEventListener('keydown', this.onKeyDown);
            }
        };
    }
}
