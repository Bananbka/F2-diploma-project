import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { SuccessResponse } from '../models/api.model';
import { Contact } from '../models/chat.model';
import { ConfigService } from './config.service';

@Injectable({ providedIn: 'root' })
export class ContactsApiService {
    private readonly http = inject(HttpClient);
    private readonly configService = inject(ConfigService);

    /** Singular, matching the router prefix in api/app/domains/users/routers/contact_routes.py. */
    private get apiUrl(): string {
        return this.configService.apiUrl + 'contact/';
    }

    getContacts(): Observable<Contact[]> {
        return this.http.get<SuccessResponse<Contact[]>>(this.apiUrl).pipe(map((r) => r.data));
    }

    /**
     * Add a contact, or rename one that already exists.
     *
     * The endpoint upserts on `(owner_id, contact_id)`, so this doubles as a rename — and passing no
     * alias clears any alias already set, rather than leaving it alone. Callers that only mean to add
     * someone should pass the alias they want kept.
     *
     * Note the field names differ in each direction: the request takes `target_user_id` and `alias`,
     * the response returns `contact_id` and `alias_name`.
     */
    addContact(targetUserId: string, alias?: string): Observable<Contact> {
        return this.http
            .post<SuccessResponse<Contact>>(this.apiUrl, { target_user_id: targetUserId, alias: alias ?? null })
            .pipe(map((r) => r.data));
    }
}
