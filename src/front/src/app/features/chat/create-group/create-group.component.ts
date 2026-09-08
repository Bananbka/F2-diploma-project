import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ArrowLeft, Check, LucideAngularModule, Search, ShieldCheck, Users } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { UserSearchResult } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { isEncryptionRefused } from '../../../core/services/crypto-errors';
import { DirectoryService } from '../../../core/services/directory.service';
import { applyServerErrors, errorTextFor } from '../../../shared/forms/server-errors';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';

@Component({
    selector: 'app-create-group',
    imports: [ReactiveFormsModule, LucideAngularModule, AvatarComponent],
    templateUrl: './create-group.component.html',
    styleUrl: './create-group.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateGroupComponent {
    private readonly chatApi = inject(ChatApiService);
    private readonly cryptoApi = inject(CryptoApiService);
    private readonly directory = inject(DirectoryService);
    private readonly store = inject(ChatStoreService);
    private readonly router = inject(Router);
    private readonly fb = inject(FormBuilder);

    readonly query = signal('');
    readonly results = signal<UserSearchResult[]>([]);
    readonly selected = signal<UserSearchResult[]>([]);
    readonly searching = signal(false);
    readonly submitting = signal(false);
    readonly error = signal<string | null>(null);

    readonly form = this.fb.nonNullable.group({
        title: ['', [Validators.required, Validators.maxLength(255)]],
        description: [''],
    });

    readonly canCreate = computed(() => this.form.valid && this.selected().length > 0 && !this.submitting());

    titleError(): string | null {
        return errorTextFor(this.form.controls.title, {
            required: 'Give the group a name.',
            maxlength: 'Keep this to 255 characters or fewer.',
        });
    }

    readonly arrowLeftIcon = ArrowLeft;
    readonly searchIcon = Search;
    readonly checkIcon = Check;
    readonly shieldCheckIcon = ShieldCheck;
    readonly usersIcon = Users;

    private searchTimer: ReturnType<typeof setTimeout> | null = null;

    onQuery(value: string): void {
        this.query.set(value);

        if (this.searchTimer) {
            clearTimeout(this.searchTimer);
        }

        if (value.trim().length < 2) {
            this.results.set([]);
            return;
        }

        this.searchTimer = setTimeout(async () => {
            this.searching.set(true);
            try {
                this.results.set(await this.directory.search(value.trim(), 20));
            } catch {
                this.results.set([]);
            } finally {
                this.searching.set(false);
            }
        }, 250);
    }

    isSelected(person: UserSearchResult): boolean {
        return this.selected().some((p) => p.id === person.id);
    }

    toggle(person: UserSearchResult): void {
        this.selected.update((current) =>
            current.some((p) => p.id === person.id) ? current.filter((p) => p.id !== person.id) : [...current, person]
        );
    }

    /**
     * Create, then switch the group on.
     *
     * Encryption is a second call because `POST /chats/group` only creates the chat; the first key
     * epoch is allocated by `POST /crypto/chats/{id}/enable`. Without it the group would stay in
     * cloud-chat mode and its messages would be stored as plaintext.
     */
    async create(): Promise<void> {
        if (!this.canCreate()) {
            this.form.markAllAsTouched();
            return;
        }

        this.submitting.set(true);
        this.error.set(null);

        const { title, description } = this.form.getRawValue();

        try {
            const chat = await firstValueFrom(
                this.chatApi.createGroupChat(
                    title,
                    description,
                    this.selected().map((p) => p.id)
                )
            );

            try {
                await firstValueFrom(this.cryptoApi.enableEncryption(chat.id));
            } catch (enableError) {
                // The group exists either way, so report the reason instead of stranding the user
                // here. A refusal is permanent and worth quoting; anything else the store retries
                // when the chat is opened.
                const refusal = isEncryptionRefused(enableError);
                if (refusal) {
                    this.error.set(`The group was created, but ${refusal.charAt(0).toLowerCase()}${refusal.slice(1)}`);
                    return;
                }
            }

            await this.store.loadChats();
            await this.router.navigate(['/chats', chat.id]);
        } catch (error) {
            this.error.set(applyServerErrors(this.form, error) ?? 'Could not create the group.');
        } finally {
            this.submitting.set(false);
        }
    }

    async cancel(): Promise<void> {
        await this.router.navigate(['/chats']);
    }
}
