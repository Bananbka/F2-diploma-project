import { inject, Pipe, PipeTransform, SecurityContext } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { twemojifyHtml } from './twemojify';

/**
 * Renders plain, untrusted text as sanitized HTML with every emoji swapped for a self-hosted
 * Twemoji `<img>` — the one approved way to get Twemoji into a template via `[innerHTML]`.
 *
 * Deliberately `sanitize(SecurityContext.HTML, ...)`, never `bypassSecurityTrustHtml`: the latter
 * would skip Angular's own stripping of any attribute or tag that nonetheless made it through
 * `twemojifyHtml`'s escape-then-replace pass, which matters here because message text is
 * attacker-controlled (this is an E2E messenger — the plaintext comes from another user).
 *
 * Pure, so Angular only re-runs it when the input reference changes.
 */
@Pipe({
    name: 'twemoji',
    standalone: true,
    pure: true,
})
export class TwemojiPipe implements PipeTransform {
    private readonly sanitizer = inject(DomSanitizer);

    transform(value: string | null | undefined): SafeHtml {
        if (!value) {
            return '';
        }
        const html = twemojifyHtml(value);
        return this.sanitizer.sanitize(SecurityContext.HTML, html) ?? '';
    }
}
