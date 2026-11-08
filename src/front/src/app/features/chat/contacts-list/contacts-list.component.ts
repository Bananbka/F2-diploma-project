import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule, MessageSquare, Pencil, Search, UserMinus } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { Contact } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { ContactsStoreService } from '../../../core/services/contacts-store.service';
import { ToastService } from '../../../core/services/toast.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';
import { ContextMenuDirective, ContextMenuProvider } from '../../../shared/ui/context-menu/context-menu.directive';
import { ContextMenuEntry } from '../../../shared/ui/context-menu/context-menu.model';

/** The name a contact goes by: the user's own alias if set, otherwise the account's name. */
export function contactName(contact: Contact): string {
    return contact.alias_name?.trim() || contact.user.full_name;
}

/**
 * The Contacts view in the sidebar column: everyone the user has saved, searchable, with Message,
 * Rename (alias) and Remove on each. Opening one starts or reuses the private chat.
 */
@Component({
    selector: 'app-contacts-list',
    imports: [LucideAngularModule, AvatarComponent, ContextMenuDirective],
    templateUrl: './contacts-list.component.html',
    styleUrl: './contacts-list.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContactsListComponent {
    private readonly store = inject(ContactsStoreService);
    private readonly chatApi = inject(ChatApiService);
    private readonly chatStore = inject(ChatStoreService);
    private readonly router = inject(Router);
    private readonly confirm = inject(ConfirmService);
    private readonly toast = inject(ToastService);
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

    readonly loading = this.store.loading;
    readonly error = this.store.error;
    readonly query = signal('');
    /** The contact whose alias is being edited inline, and the draft text. */
    readonly renaming = signal<string | null>(null);
    readonly draft = signal('');

    readonly searchIcon = Search;
    readonly contactName = contactName;

    readonly visible = computed(() => {
        const needle = this.query().trim().toLowerCase();
        return this.store
            .contacts()
            .filter(
                (c) =>
                    !needle ||
                    contactName(c).toLowerCase().includes(needle) ||
                    c.user.full_name.toLowerCase().includes(needle) ||
                    c.user.username.toLowerCase().includes(needle)
            )
            .sort((a, b) => contactName(a).localeCompare(contactName(b)));
    });

    readonly total = computed(() => this.store.contacts().length);

    constructor() {
        void this.store.load();
    }

    menu(contact: Contact): ContextMenuProvider {
        return (): ContextMenuEntry[] => [
            { icon: MessageSquare, label: 'Message', action: () => void this.message(contact) },
            { icon: Pencil, label: 'Rename…', action: () => this.startRename(contact) },
            { separator: true },
            { icon: UserMinus, label: 'Remove contact', danger: true, action: () => void this.remove(contact) },
        ];
    }

    /** Same flow as starting a chat from search: create-or-get the private chat, then open it. */
    async message(contact: Contact): Promise<void> {
        try {
            const chat = await firstValueFrom(this.chatApi.createPrivateChat(contact.contact_id));
            await this.chatStore.loadChats();
            await this.router.navigate(['/chats', chat.id]);
        } catch {
            this.toast.error('Could not open that chat.');
        }
    }

    startRename(contact: Contact): void {
        this.draft.set(contact.alias_name ?? '');
        this.renaming.set(contact.contact_id);
        // The input only exists after the next render; select its text so typing replaces the alias.
        setTimeout(() => {
            const field = this.host.nativeElement.querySelector<HTMLInputElement>('.alias-input');
            field?.focus();
            field?.select();
        });
    }

    cancelRename(): void {
        this.renaming.set(null);
    }

    async commitRename(contact: Contact): Promise<void> {
        if (this.renaming() !== contact.contact_id) {
            return;
        }
        this.renaming.set(null);
        if ((contact.alias_name ?? '') === this.draft().trim()) {
            return;
        }
        if (await this.store.rename(contact, this.draft())) {
            // Private chat titles are resolved server-side against the alias.
            void this.chatStore.loadChats();
        } else {
            this.toast.error('Could not rename that contact.');
        }
    }

    async remove(contact: Contact): Promise<void> {
        const confirmed = await this.confirm.ask({
            title: 'Remove contact?',
            message: `${contactName(contact)} is removed from your contacts. Your chat with them is not affected.`,
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!confirmed) {
            return;
        }
        if (await this.store.remove(contact)) {
            void this.chatStore.loadChats();
        } else {
            this.toast.error('Could not remove that contact.');
        }
    }
}
