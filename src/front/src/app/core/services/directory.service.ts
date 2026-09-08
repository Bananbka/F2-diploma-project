import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { UserSearchResult } from '../models/chat.model';
import { ChatApiService } from './chat-api.service';
import { ContactsApiService } from './contacts-api.service';
import { SessionService } from './session.service';

export interface DisplayIdentity {
    userId: string;
    name: string;
    username: string | null;
    avatarUrl: string | null;
    /** False when the name is a placeholder we derived from the id rather than a real profile. */
    resolved: boolean;
}

/**
 * Maps user ids to something displayable.
 *
 * This exists because the API has no way to fetch a profile by user id: `GET /users/{query}`
 * matches on username or phone only, and neither the chat participant list nor the crypto roster
 * carries names. So the directory is assembled from the sources that *are* keyed by id — the signed
 * in user and `GET /contacts` — and warmed opportunistically from search results.
 *
 * Anything still unresolved renders as a short id rather than a guess. A message attributed to the
 * wrong person is worse than one attributed to nobody, and in a chat whose whole point is
 * authenticated authorship it would undercut the guarantee outright.
 */
@Injectable({ providedIn: 'root' })
export class DirectoryService {
    private readonly contactsApi = inject(ContactsApiService);
    private readonly chatApi = inject(ChatApiService);
    private readonly session = inject(SessionService);

    private readonly known = signal(new Map<string, DisplayIdentity>());
    private contactsLoaded = false;

    /** True when the contact directory could not be loaded, so names are degraded for a reason. */
    readonly warmFailed = signal(false);

    /** Pull in every id-keyed source we have. Cheap and idempotent. */
    async warm(): Promise<void> {
        const me = this.session.user();
        if (me) {
            this.remember({
                userId: me.id,
                name: me.full_name,
                username: me.username,
                avatarUrl: me.avatar,
                resolved: true,
            });
        }

        if (this.contactsLoaded) {
            return;
        }

        try {
            const contacts = await firstValueFrom(this.contactsApi.getContacts());
            for (const contact of contacts) {
                this.remember({
                    userId: contact.contact_id,
                    name: contact.alias_name || contact.user.full_name,
                    username: contact.user.username,
                    avatarUrl: contact.user.avatar_url,
                    resolved: true,
                });
            }
            this.contactsLoaded = true;
            this.warmFailed.set(false);
        } catch {
            // Non-fatal — unresolved members keep their placeholder label — but recorded rather than
            // swallowed. This call spent a long time silently 404ing against the wrong path, and the
            // only symptom was names quietly degrading to ids, which looks like a missing API rather
            // than a broken request.
            this.warmFailed.set(true);
        }
    }

    /** Cache anything a search turned up, so later renders of those members are resolved. */
    rememberSearchResults(results: UserSearchResult[]): void {
        for (const result of results) {
            this.remember({
                userId: result.id,
                name: result.full_name,
                username: result.username,
                avatarUrl: result.avatar_url,
                resolved: true,
            });
        }
    }

    async search(query: string, limit = 10): Promise<UserSearchResult[]> {
        const results = await firstValueFrom(this.chatApi.searchUsers(query, limit));
        this.rememberSearchResults(results);
        return results;
    }

    /**
     * A private chat's title is the counterpart's display name, resolved server-side against the
     * contact alias. That makes it the one place a DM peer's name is reliably available.
     */
    rememberPrivateChatPeer(userId: string, title: string | null, avatarUrl: string | null): void {
        if (!title) {
            return;
        }
        this.remember({ userId, name: title, username: null, avatarUrl, resolved: true });
    }

    /**
     * Resolve ids we do not already know, in one request.
     *
     * `POST /users/batch` is the only endpoint keyed by user id, so this is what lets a group member
     * who is not a contact show a name instead of a truncated uuid. Already-known ids are filtered
     * out first: contacts carry a user-set alias, and a batch lookup would overwrite it with the
     * global full name.
     */
    async resolveMissing(userIds: readonly string[]): Promise<void> {
        const known = this.known();
        const missing = [...new Set(userIds)].filter((id) => !known.has(id));

        if (missing.length === 0) {
            return;
        }

        try {
            this.rememberSearchResults(await firstValueFrom(this.chatApi.getUsersBatch(missing)));
        } catch {
            // Placeholder labels remain. Not worth failing a render over.
        }
    }

    lookup(userId: string): DisplayIdentity {
        return (
            this.known().get(userId) ?? {
                userId,
                name: `Member ${userId.slice(0, 8)}`,
                username: null,
                avatarUrl: null,
                resolved: false,
            }
        );
    }

    isMe(userId: string): boolean {
        return this.session.user()?.id === userId;
    }

    private remember(identity: DisplayIdentity): void {
        this.known.update((map) => {
            const next = new Map(map);
            next.set(identity.userId, identity);
            return next;
        });
    }
}
