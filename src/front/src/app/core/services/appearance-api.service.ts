import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { SuccessResponse } from '../models/api.model';
import { Appearance } from '../models/appearance.model';
import { ConfigService } from './config.service';

/** `/profile/me/appearance`: per-user chat appearance, replace semantics on PUT. */
@Injectable({ providedIn: 'root' })
export class AppearanceApiService {
    private readonly http = inject(HttpClient);
    private readonly config = inject(ConfigService);

    private get url(): string {
        return `${this.config.apiUrl}profile/me/appearance`;
    }

    get(): Observable<Appearance> {
        return this.http.get<SuccessResponse<Appearance>>(this.url).pipe(map((r) => r.data));
    }

    put(appearance: Appearance): Observable<Appearance> {
        return this.http.put<SuccessResponse<Appearance>>(this.url, appearance).pipe(map((r) => r.data));
    }

    reset(): Observable<Appearance> {
        return this.http.delete<SuccessResponse<Appearance>>(this.url).pipe(map((r) => r.data));
    }
}
