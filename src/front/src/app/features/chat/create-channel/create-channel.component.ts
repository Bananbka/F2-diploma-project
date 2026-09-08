import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ArrowLeft, Check, Hash, LucideAngularModule, Search, ShieldOff } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { UserSearchResult } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { applyServerErrors, errorTextFor } from '../../../shared/forms/server-errors';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';

@Component({
    selector: 'app-create-channel',
    imports: [ReactiveFormsModule, LucideAngularModule, AvatarComponent],
    templateUrl: './create-channel.component.html',
    styleUrl: './create-channel.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateChannelComponent {
    private readonly chatApi = inject(ChatApiService);
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

    readonly slug = computed(() => this.form.controls.title.value.trim().toLowerCase().replace(/\s+/g, '-'));
    readonly canCreate = computed(() => this.form.valid && !this.submitting());

    titleError(): string | null {
        return errorTextFor(this.form.controls.title, {
            required: 'Give the channel a name.',
            maxlength: 'Keep this to 255 characters or fewer.',
        });
    }

    readonly arrowLeftIcon = ArrowLeft;
    readonly searchIcon = Search;
    readonly checkIcon = Check;
    readonly hashIcon = Hash;
    readonly shieldOffIcon = ShieldOff;

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
                this.chatApi.createChannel(
                    title,
                    description,
                    this.selected().map((p) => p.id)
                )
            );

            await this.store.loadChats();
            await this.router.navigate(['/chats', chat.id]);
        } catch (error) {
            this.error.set(applyServerErrors(this.form, error) ?? 'Could not create the channel.');
        } finally {
            this.submitting.set(false);
        }
    }

    async cancel(): Promise<void> {
        await this.router.navigate(['/chats']);
    }
}
