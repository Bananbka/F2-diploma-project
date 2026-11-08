import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Contact } from '../models/chat.model';
import { ContactsApiService } from './contacts-api.service';

/** The signed-in user's saved contacts, for the Contacts view. */
@Injectable({ providedIn: 'root' })
export class ContactsStoreService {
    private readonly api = inject(ContactsApiService);

    readonly contacts = signal<Contact[]>([]);
    readonly loading = signal(false);
    readonly error = signal<string | null>(null);

    async load(): Promise<void> {
        this.loading.set(true);
        this.error.set(null);
        try {
            this.contacts.set(await firstValueFrom(this.api.getContacts()));
        } catch {
            this.error.set('Could not load your contacts.');
        } finally {
            this.loading.set(false);
        }
    }

    /**
     * Rename. The endpoint upserts and an absent alias clears it, so an empty name is sent as no alias
     * on purpose: that is how a nickname is removed.
     */
    async rename(contact: Contact, alias: string): Promise<boolean> {
        const trimmed = alias.trim();
        try {
            const saved = await firstValueFrom(this.api.addContact(contact.contact_id, trimmed || undefined));
            this.contacts.update((list) =>
                list.map((c) =>
                    c.contact_id === contact.contact_id
                        ? { ...c, alias_name: saved.alias_name ?? (trimmed || null) }
                        : c
                )
            );
            return true;
        } catch {
            return false;
        }
    }

    async remove(contact: Contact): Promise<boolean> {
        try {
            await firstValueFrom(this.api.removeContact(contact.contact_id));
            this.contacts.update((list) => list.filter((c) => c.contact_id !== contact.contact_id));
            return true;
        } catch {
            return false;
        }
    }
}
