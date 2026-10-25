import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { SuccessResponse } from '../models/api.model';
import { UserProfile } from '../models/chat.model';
import { ConfigService } from './config.service';

/**
 * Fields `PATCH /profile/me` accepts.
 *
 * `full_name` is required on every request despite the verb — the schema does not default it, so a
 * partial update still has to carry it. `username` must be omitted rather than sent as null: its
 * validator has no null guard and an explicit null raises server-side.
 */
export interface ProfileUpdateRequest {
    full_name: string;
    username?: string;
    bio?: string;
    avatar_url?: string;
}

export interface UploadedFile {
    url: string;
    name: string;
    size: number;
    content_type: string;
}

@Injectable({ providedIn: 'root' })
export class ProfileApiService {
    private readonly http = inject(HttpClient);
    private readonly configService = inject(ConfigService);

    updateProfile(data: ProfileUpdateRequest): Observable<UserProfile> {
        return this.http
            .patch<SuccessResponse<UserProfile>>(`${this.configService.apiUrl}profile/me`, data)
            .pipe(map((r) => r.data));
    }

    /**
     * Permanently delete the signed-in account (`DELETE /profile`).
     *
     * The password is re-entered rather than trusted from the session, so a stolen cookie is not
     * enough to destroy an account. It travels in a JSON body on a DELETE, which `HttpClient.delete`
     * cannot express — hence `request`. Errors callers should expect: 401 `INVALID_PASSWORD`, and
     * 429 once the attempt limit is hit.
     */
    deleteAccount(password: string): Observable<unknown> {
        return this.http
            .request<SuccessResponse<unknown>>('DELETE', `${this.configService.apiUrl}profile`, {
                body: { password },
            })
            .pipe(map((r) => r.data));
    }

    isUsernameAvailable(username: string): Observable<boolean> {
        return this.http
            .get<SuccessResponse<boolean>>(`${this.configService.apiUrl}profile/is-username-available/${username}`)
            .pipe(map((r) => r.data));
    }

    /**
     * Upload to MinIO.
     *
     * The avatar bucket carries a public-read policy, so its URL works directly in an `<img src>`.
     * The message bucket does not — those need the authorised download endpoint.
     *
     * Accepts a bare `Blob` as well as a `File` — an encrypted attachment blob has no filename of
     * its own, so a message upload supplies one explicitly rather than relying on the object
     * carrying it.
     */
    upload(file: Blob | File, category: 'avatar' | 'message' | 'sticker', filename?: string): Observable<UploadedFile> {
        const body = new FormData();
        body.append('file', file, filename ?? (file instanceof File ? file.name : 'file'));
        body.append('category', category);

        return this.http
            .post<SuccessResponse<UploadedFile>>(`${this.configService.apiUrl}files/upload`, body)
            .pipe(map((r) => r.data));
    }
}
