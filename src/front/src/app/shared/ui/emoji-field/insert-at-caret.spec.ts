import { insertAtCaret } from './insert-at-caret';

describe('insertAtCaret', () => {
    let input: HTMLInputElement;

    beforeEach(() => {
        input = document.createElement('input');
        document.body.appendChild(input);
    });

    afterEach(() => input.remove());

    it('inserts at the caret and moves the caret after it', () => {
        input.value = 'abcd';
        input.setSelectionRange(2, 2);
        expect(insertAtCaret(input, '😀')).toBeTrue();
        expect(input.value).toBe('ab😀cd');
        expect(input.selectionStart).toBe(4);
        expect(input.selectionEnd).toBe(4);
    });

    it('replaces the selection', () => {
        input.value = 'hello world';
        input.setSelectionRange(6, 11);
        insertAtCaret(input, '🌍');
        expect(input.value).toBe('hello 🌍');
    });

    it('fires a bubbling input event', () => {
        const seen: string[] = [];
        document.body.addEventListener('input', () => seen.push(input.value), { once: true });
        insertAtCaret(input, '👍');
        expect(seen).toEqual(['👍']);
    });

    it('works on a textarea', () => {
        const area = document.createElement('textarea');
        area.value = 'ab';
        area.setSelectionRange(1, 1);
        insertAtCaret(area, '🎉');
        expect(area.value).toBe('a🎉b');
    });

    it('refuses an insert that would exceed maxLength', () => {
        input.maxLength = 3;
        input.value = 'ab';
        input.setSelectionRange(2, 2);
        expect(insertAtCaret(input, '😀')).toBeFalse();
        expect(input.value).toBe('ab');
    });
});
