import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';

import { environment } from '../../../environments/environment';

export interface AppConfig {
    apiUrl: string;
    wsUrl: string;
}

/**
 * Runtime configuration.
 *
 * In production the container writes /config.json at start, so one image can be deployed against
 * different backends without a rebuild. Development short-circuits to the compiled environment.
 */
@Injectable({ providedIn: 'root' })
export class ConfigService {
    private readonly http = inject(HttpClient);

    private config: AppConfig = { apiUrl: environment.apiUrl, wsUrl: environment.wsUrl };

    async load(): Promise<void> {
        if (!environment.production) {
            return;
        }

        const loaded = await firstValueFrom(this.http.get<AppConfig>('/config.json').pipe(catchError(() => of(null))));

        if (loaded) {
            this.config = loaded;
        }
    }

    get apiUrl(): string {
        return this.config.apiUrl;
    }

    get wsUrl(): string {
        return this.config.wsUrl;
    }
}
