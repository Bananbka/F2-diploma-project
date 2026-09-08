import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, inject, provideAppInitializer, provideZoneChangeDetection } from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

import { routes } from './app.routes';
import { credentialsInterceptor } from './core/interceptors/credentials.interceptor';
import { refreshInterceptor } from './core/interceptors/refresh.interceptor';
import { ConfigService } from './core/services/config.service';
import { SessionService } from './core/services/session.service';

export const appConfig: ApplicationConfig = {
    providers: [
        provideZoneChangeDetection({ eventCoalescing: true }),
        provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
        provideAnimationsAsync(),
        // Order matters: credentials must be attached before the refresh interceptor replays a
        // request, or the replay would go out unauthenticated.
        provideHttpClient(withInterceptors([credentialsInterceptor, refreshInterceptor])),
        // provideAppInitializer rather than the deprecated APP_INITIALIZER token. Config must land
        // before the session probe, since the probe needs the resolved API base URL.
        //
        // Both services are resolved up front, before the first await: the injection context ends at
        // the initial suspension, so an inject() after one throws NG0203.
        provideAppInitializer(() => {
            const config = inject(ConfigService);
            const session = inject(SessionService);

            return config.load().then(() => session.restore());
        }),
    ],
};
