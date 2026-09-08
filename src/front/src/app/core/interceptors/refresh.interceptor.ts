import { HttpErrorResponse, HttpHandlerFn, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, Observable, of, shareReplay, switchMap, throwError } from 'rxjs';

import { AuthApiService } from '../services/auth-api.service';
import { KeyStoreService } from '../services/key-store.service';

/**
 * Endpoints where a 401 is the answer, not a stale token.
 *
 * Retrying a failed login through the refresh path would turn a wrong password into a confusing
 * redirect, and refreshing the refresh call itself would recurse.
 */
const NO_RETRY = ['auth/login', 'auth/register', 'auth/refresh', 'auth/logout', 'auth/verify-email'];

/**
 * A single in-flight refresh, shared by every request that gets a 401 at once.
 *
 * Module scope rather than a service field because interceptors are functions: a page-load burst of
 * parallel calls would otherwise fire one refresh each, and all but the first would race against the
 * rotated cookie.
 */
let refreshInFlight: Observable<unknown> | null = null;

export const refreshInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
    const authApi = inject(AuthApiService);
    const keyStore = inject(KeyStoreService);
    const router = inject(Router);

    if (NO_RETRY.some((path) => req.url.includes(path))) {
        return next(req);
    }

    return next(req).pipe(
        catchError((error: unknown) => {
            if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
                return throwError(() => error);
            }

            refreshInFlight ??= authApi.refresh().pipe(
                // shareReplay so latecomers get the same result rather than starting another refresh;
                // the flag is cleared either way so a later 401 can try again.
                shareReplay({ bufferSize: 1, refCount: false }),
                catchError(() => of(null))
            );

            return refreshInFlight.pipe(
                switchMap((refreshed) => {
                    refreshInFlight = null;

                    if (refreshed === null) {
                        // The session is genuinely over. Drop the unlocked keys rather than leaving
                        // them in memory for a page the user can no longer use.
                        keyStore.lock();
                        void router.navigate(['/login']);
                        return throwError(() => error);
                    }

                    // Cookies were rotated in place, so the original request can simply be replayed.
                    return next(req);
                })
            );
        })
    );
};
