import { HttpHandlerFn, HttpInterceptorFn, HttpRequest } from '@angular/common/http';

/**
 * Attach cookies to every backend call.
 *
 * The backend issues access and refresh tokens as **httpOnly** cookies (see
 * api/app/core/security.py), so JavaScript cannot read them and there is no Authorization header
 * to set. That is deliberately stronger than a token in a JS-readable cookie or localStorage:
 * an XSS foothold cannot exfiltrate a token it cannot see.
 *
 * The only thing the client must do is opt into sending credentials cross-origin.
 */
export const credentialsInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
    // config.json is served by our own origin and needs no credentials.
    if (req.url.startsWith('/config.json')) {
        return next(req);
    }

    return next(req.clone({ withCredentials: true }));
};
