import { HttpErrorResponse } from '@angular/common/http';
import { AbstractControl, FormGroup } from '@angular/forms';
import { take } from 'rxjs';

import { ValidationDetail } from '../../core/models/api.model';

/** Pydantic prefixes messages raised by a field validator. The prefix is noise to a reader. */
const PYDANTIC_PREFIX = /^Value error,\s*/;

function toCamelCase(value: string): string {
    return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function detailsFrom(error: unknown): ValidationDetail[] {
    if (!(error instanceof HttpErrorResponse)) {
        return [];
    }

    const details = (error.error as { details?: unknown } | null)?.details;
    return Array.isArray(details) ? (details as ValidationDetail[]) : [];
}

/**
 * Attach a server-side validation failure to the control that caused it.
 *
 * The backend is the authority on several of these rules — a phone number goes through
 * libphonenumber, and username collisions can only be known server-side — so the client cannot
 * pre-empt them all. What it can do is stop reporting them as one opaque "Data validation error"
 * banner and put each message on its field.
 *
 * Returns whatever could not be attributed to a control, for the form-level error slot.
 */
export function applyServerErrors(form: FormGroup, error: unknown): string | null {
    const details = detailsFrom(error);

    if (details.length === 0) {
        if (error instanceof HttpErrorResponse) {
            const message = (error.error as { message?: unknown } | null)?.message;
            if (typeof message === 'string') {
                return message;
            }
        }
        return null;
    }

    const unattributed: string[] = [];

    for (const detail of details) {
        // Drop the 'body' / 'query' segment the location always starts with.
        const field = detail.loc.filter((part) => typeof part === 'string' && part !== 'body').at(-1);
        const message = detail.msg.replace(PYDANTIC_PREFIX, '');

        const control = typeof field === 'string' ? form.get(toCamelCase(field)) : null;

        if (control) {
            setServerError(control, message);
        } else {
            unattributed.push(message);
        }
    }

    return unattributed.length > 0 ? unattributed.join(' ') : null;
}

/**
 * Mark a control as rejected by the server.
 *
 * The error clears on the next edit: leaving it in place would keep the field red while the user
 * fixes it, and a control that stays invalid after being corrected trains people to ignore the
 * colour.
 */
export function setServerError(control: AbstractControl, message: string): void {
    control.setErrors({ ...(control.errors ?? {}), server: message });
    control.markAsTouched();

    control.valueChanges.pipe(take(1)).subscribe(() => clearServerError(control));
}

export function clearServerError(control: AbstractControl): void {
    if (!control.errors?.['server']) {
        return;
    }

    const remaining = { ...control.errors };
    delete remaining['server'];
    control.setErrors(Object.keys(remaining).length > 0 ? remaining : null);
}

/** The message to show under a control, server-supplied or local, or null when it is fine. */
export function errorTextFor(control: AbstractControl, local: Partial<Record<string, string>>): string | null {
    if (!control.touched || !control.errors) {
        return null;
    }

    const server = control.errors['server'];
    if (typeof server === 'string') {
        return server;
    }

    for (const key of Object.keys(control.errors)) {
        const text = local[key];
        if (text) {
            return text;
        }
    }

    return null;
}
