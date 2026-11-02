import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { SuccessResponse } from '../models/api.model';
import { ConfigService } from './config.service';

/** Requests send `chat_ids`; responses come back as `items`. The asymmetry is the API's, not ours. */
export interface Folder {
    id: string;
    title: string;
    /** A lucide kebab-case icon name, or null/absent for the default. */
    icon?: string | null;
    items: { chat_id: string }[];
}

@Injectable({ providedIn: 'root' })
export class FolderApiService {
    private readonly http = inject(HttpClient);
    private readonly configService = inject(ConfigService);

    /** Singular and hyphenated, matching the router prefix — not `/folders`. */
    private get apiUrl(): string {
        return this.configService.apiUrl + 'chat-folder/';
    }

    getFolders(): Observable<Folder[]> {
        return this.http.get<SuccessResponse<Folder[]>>(this.apiUrl).pipe(map((r) => r.data));
    }

    createFolder(title: string, chatIds: string[], icon?: string | null): Observable<Folder> {
        return this.http
            .post<SuccessResponse<Folder>>(this.apiUrl, { title, chat_ids: chatIds, ...(icon ? { icon } : {}) })
            .pipe(map((r) => r.data));
    }

    /**
     * Update a folder.
     *
     * `chat_ids` is a **full replace** despite the verb: sending `[]` empties the folder, and omitting
     * the key entirely leaves its contents untouched. Callers that mean to add one chat must send the
     * whole resulting set. `icon` omitted leaves it unchanged; `null` clears it.
     */
    updateFolder(
        folderId: string,
        changes: { title?: string; chat_ids?: string[]; icon?: string | null }
    ): Observable<Folder> {
        return this.http.patch<SuccessResponse<Folder>>(`${this.apiUrl}${folderId}`, changes).pipe(map((r) => r.data));
    }

    deleteFolder(folderId: string): Observable<unknown> {
        return this.http.delete<SuccessResponse<unknown>>(`${this.apiUrl}${folderId}`).pipe(map((r) => r.data));
    }
}
