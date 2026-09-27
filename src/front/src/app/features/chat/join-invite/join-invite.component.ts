import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Hash, Link, LucideAngularModule, ShieldAlert, UserPlus, Users } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { InviteLinkPreview } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';

/**
 * The `/join/:token` deep link a chat-info "Copy link" button constructs, and what a clicked
 * invite link resolves to client-side. `GET /invite-links/{token}` is a real, path-addressed
 * endpoint by design (see `invite_link_routes.py`), but the SPA never links straight to the API —
 * this route calls it, then renders the decision rather than the raw JSON.
 */
@Component({
    selector: 'app-join-invite',
    imports: [LucideAngularModule, AvatarComponent],
    templateUrl: './join-invite.component.html',
    styleUrl: './join-invite.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JoinInviteComponent {
    private readonly chatApi = inject(ChatApiService);
    private readonly store = inject(ChatStoreService);
    private readonly router = inject(Router);

    readonly token = input.required<string>();

    readonly loading = signal(true);
    readonly joining = signal(false);
    readonly error = signal<string | null>(null);
    readonly preview = signal<InviteLinkPreview | null>(null);

    /**
     * The preview endpoint deliberately does not say whether the caller is already a member (see
     * `InviteLinkPreviewResponse`'s docstring — it withholds the roster). Whether we already hold
     * this chat in the sidebar list is the same fact by another route, so it doubles as the
     * "already a member" signal without a second endpoint.
     */
    readonly alreadyMember = computed(() => {
        const chatId = this.preview()?.chat_id;
        return chatId !== undefined && this.store.chats().some((c) => c.id === chatId);
    });

    readonly title = computed(() => {
        const preview = this.preview();
        if (!preview) {
            return '';
        }
        return preview.title ?? (preview.chat_type === 'channel' ? 'Channel' : 'Untitled group');
    });

    readonly linkIcon = Link;
    readonly usersIcon = Users;
    readonly userPlusIcon = UserPlus;
    readonly alertIcon = ShieldAlert;
    readonly hashIcon = Hash;

    constructor() {
        effect(() => void this.load(this.token()));
    }

    private async load(token: string): Promise<void> {
        this.loading.set(true);
        this.error.set(null);
        this.preview.set(null);

        try {
            const preview = await firstValueFrom(this.chatApi.previewInviteLink(token));
            this.preview.set(preview);

            // Membership only needs checking against a loaded list; a fresh session may not have
            // fetched it yet, and `alreadyMember` reads through the same store either way.
            if (this.store.chats().length === 0) {
                await this.store.loadChats();
            }
        } catch (error) {
            this.error.set(this.previewErrorMessage(error));
        } finally {
            this.loading.set(false);
        }
    }

    private previewErrorMessage(error: unknown): string {
        if (error instanceof HttpErrorResponse && (error.status === 404 || error.status === 410)) {
            return 'This invite link is invalid or has expired.';
        }
        return 'Could not load this invite link. Please try again.';
    }

    async join(): Promise<void> {
        const preview = this.preview();
        if (!preview || this.joining()) {
            return;
        }

        if (this.alreadyMember()) {
            await this.enterChat(preview.chat_id);
            return;
        }

        this.joining.set(true);
        this.error.set(null);
        try {
            const result = await firstValueFrom(this.chatApi.joinInviteLink(this.token()));
            await this.store.loadChats();
            await this.enterChat(result.chat_id);
        } catch (error) {
            this.error.set(this.joinErrorMessage(error));
        } finally {
            this.joining.set(false);
        }
    }

    private joinErrorMessage(error: unknown): string {
        if (error instanceof HttpErrorResponse && (error.status === 404 || error.status === 410)) {
            return 'This invite link is invalid or has expired.';
        }
        return 'Could not join this chat. Please try again.';
    }

    private async enterChat(chatId: string): Promise<void> {
        await this.router.navigate(['/chats', chatId]);
    }
}
