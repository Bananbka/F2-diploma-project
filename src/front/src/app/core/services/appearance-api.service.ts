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

    uploadBackgroundImage(file: File): Observable<Appearance> {
        const body = new FormData();
        body.append('file', file);
        return this.http
            .put<SuccessResponse<Appearance>>(`${this.url}/background-image`, body)
            .pipe(map((r) => r.data));
    }

    deleteBackgroundImage(): Observable<Appearance> {
        return this.http.delete<SuccessResponse<Appearance>>(`${this.url}/background-image`).pipe(map((r) => r.data));
    }

    /** The picture itself, fetched with the session cookie; `version` busts the cache when it changes. */
    fetchBackgroundImage(version: string): Observable<Blob> {
        return this.http.get(`${this.url}/background-image`, {
            params: { v: version },
            responseType: 'blob',
        });
    }

    reset(): Observable<Appearance> {
        return this.http.delete<SuccessResponse<Appearance>>(this.url).pipe(map((r) => r.data));
    }
}
