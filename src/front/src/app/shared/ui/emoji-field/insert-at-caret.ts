export type TextControl = HTMLInputElement | HTMLTextAreaElement;

/**
 * Insert `text` into a text control at the caret, replacing any selection, then move the caret to
 * just after it and fire a bubbling `input` event so Angular forms and `(input)` handlers see the
 * change as if the user had typed it. Returns false (and changes nothing) if the result would
 * exceed the control's `maxLength`, which is counted in UTF-16 units exactly as the browser does.
 */
export function insertAtCaret(control: TextControl, text: string): boolean {
    const value = control.value;
    const start = control.selectionStart ?? value.length;
    const end = control.selectionEnd ?? start;
    const next = value.slice(0, start) + text + value.slice(end);

    if (control.maxLength >= 0 && next.length > control.maxLength) {
        return false;
    }

    control.value = next;
    const caret = start + text.length;
    control.setSelectionRange(caret, caret);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}
