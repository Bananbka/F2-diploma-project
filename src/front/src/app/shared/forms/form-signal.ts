import { Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormGroup } from '@angular/forms';
import { map, startWith } from 'rxjs';

export interface FormSnapshot<V> {
    readonly valid: boolean;
    readonly value: V;
}

/**
 * Mirror a reactive form's validity and raw value as a signal. `form.valid` and `control.value` are
 * plain properties, so a `computed()` that reads them is evaluated once and never again: it keeps
 * whatever it saw at construction (an empty, invalid form) no matter what the user types. Anything
 * derived from form state must go through this instead. Call it in an injection context.
 */
export function formSnapshot<V>(form: FormGroup & { getRawValue(): V }): Signal<FormSnapshot<V>> {
    const read = (): FormSnapshot<V> => ({ valid: form.valid, value: form.getRawValue() });
    return toSignal(form.valueChanges.pipe(startWith(null), map(read)), { initialValue: read() });
}
