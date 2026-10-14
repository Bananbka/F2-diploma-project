import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ArrowDown, ArrowLeft, ArrowUp, Globe, Lock, LucideAngularModule, Plus, Trash2, Upload } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { Sticker, StickerPack, StickerPackSummary } from '../../../../core/models/sticker.model';
import { ProfileApiService } from '../../../../core/services/profile-api.service';
import { SessionService } from '../../../../core/services/session.service';
import { StickerApiService } from '../../../../core/services/sticker-api.service';
import { TwemojiPipe } from '../../../../shared/emoji/twemoji.pipe';
import { EmojiPickerComponent } from '../../../../shared/ui/emoji-picker/emoji-picker.component';

/** Server-enforced caps, mirrored here only for UX — the backend is the real enforcer. */
const MAX_PACKS = 50;
const MAX_STICKERS_PER_PACK = 120;

/**
 * Manage the signed-in user's own sticker packs: create, delete, toggle visibility, add/remove/
 * reorder stickers.
 *
 * There is no endpoint to edit a sticker once added — `StickerCreateRequest.emoji` is the only place
 * the tag is set — so changing a sticker's emoji means deleting it and re-adding it, not an in-place
 * edit. Building an edit control here would imply a capability the backend does not have.
 */
@Component({
    selector: 'app-sticker-pack-manager',
    imports: [LucideAngularModule, EmojiPickerComponent, TwemojiPipe],
    templateUrl: './sticker-pack-manager.component.html',
    styleUrl: './sticker-pack-manager.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StickerPackManagerComponent {
    private readonly stickerApi = inject(StickerApiService);
    private readonly profileApi = inject(ProfileApiService);
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);

    readonly packs = signal<StickerPackSummary[]>([]);
    /** This screen only manages packs the signed-in user owns — `GET /stickers/packs/mine` also
     * returns subscribed-only packs, which belong on the tray/picker, not here. */
    readonly ownedPacks = computed(() => this.packs().filter((pack) => pack.owner_id === this.session.user()?.id));
    readonly loading = signal(true);
    readonly error = signal<string | null>(null);

    readonly newTitle = signal('');
    readonly creating = signal(false);

    readonly expandedPackId = signal<string | null>(null);
    readonly packDetail = signal<StickerPack | null>(null);
    readonly loadingDetail = signal(false);
    readonly titleDraft = signal('');
    readonly savingTitle = signal(false);
    readonly togglingPublic = signal(false);

    readonly uploadEmoji = signal('');
    readonly emojiPickerOpen = signal(false);
    readonly uploading = signal(false);
    readonly uploadError = signal<string | null>(null);

    readonly busyStickerId = signal<string | null>(null);
    readonly confirmingDeletePack = signal(false);
    readonly deletingPack = signal(false);

    readonly arrowLeftIcon = ArrowLeft;
    readonly plusIcon = Plus;
    readonly trashIcon = Trash2;
    readonly globeIcon = Globe;
    readonly lockIcon = Lock;
    readonly uploadIcon = Upload;
    readonly arrowUpIcon = ArrowUp;
    readonly arrowDownIcon = ArrowDown;

    readonly maxPacks = MAX_PACKS;
    readonly maxStickersPerPack = MAX_STICKERS_PER_PACK;

    readonly canCreatePack = computed(
        () => this.newTitle().trim().length > 0 && this.ownedPacks().length < MAX_PACKS && !this.creating()
    );

    readonly canAddSticker = computed(
        () => (this.packDetail()?.stickers.length ?? 0) < MAX_STICKERS_PER_PACK && !this.uploading()
    );

    constructor() {
        void this.loadPacks();
    }

    private async loadPacks(): Promise<void> {
        this.loading.set(true);
        this.error.set(null);
        try {
            this.packs.set(await firstValueFrom(this.stickerApi.getMyPacks()));
        } catch {
            this.error.set('Could not load your sticker packs.');
        } finally {
            this.loading.set(false);
        }
    }

    async createPack(): Promise<void> {
        if (!this.canCreatePack()) {
            return;
        }

        this.creating.set(true);
        this.error.set(null);
        try {
            await firstValueFrom(this.stickerApi.createPack(this.newTitle().trim()));
            this.newTitle.set('');
            await this.loadPacks();
        } catch {
            this.error.set('Could not create that pack.');
        } finally {
            this.creating.set(false);
        }
    }

    async toggleExpand(pack: StickerPackSummary): Promise<void> {
        if (this.expandedPackId() === pack.id) {
            this.expandedPackId.set(null);
            this.packDetail.set(null);
            return;
        }

        this.expandedPackId.set(pack.id);
        this.confirmingDeletePack.set(false);
        this.emojiPickerOpen.set(false);
        this.uploadError.set(null);
        this.loadingDetail.set(true);
        try {
            const detail = await firstValueFrom(this.stickerApi.getPack(pack.id));
            this.packDetail.set(detail);
            this.titleDraft.set(detail.title);
        } catch {
            this.error.set('Could not load that pack.');
            this.expandedPackId.set(null);
        } finally {
            this.loadingDetail.set(false);
        }
    }

    async saveTitle(): Promise<void> {
        const detail = this.packDetail();
        const title = this.titleDraft().trim();
        if (!detail || !title || title === detail.title) {
            return;
        }

        this.savingTitle.set(true);
        try {
            const updated = await firstValueFrom(this.stickerApi.updatePack(detail.id, { title }));
            this.packDetail.set({ ...detail, title: updated.title });
            await this.loadPacks();
        } catch {
            this.error.set('Could not rename that pack.');
        } finally {
            this.savingTitle.set(false);
        }
    }

    async togglePublic(): Promise<void> {
        const detail = this.packDetail();
        if (!detail) {
            return;
        }

        this.togglingPublic.set(true);
        try {
            const updated = await firstValueFrom(
                this.stickerApi.updatePack(detail.id, { is_public: !detail.is_public })
            );
            this.packDetail.set({ ...detail, is_public: updated.is_public });
            await this.loadPacks();
        } catch {
            this.error.set('Could not change visibility.');
        } finally {
            this.togglingPublic.set(false);
        }
    }

    toggleEmojiPicker(): void {
        this.emojiPickerOpen.update((open) => !open);
    }

    onEmojiPicked(emoji: string): void {
        this.uploadEmoji.set(emoji);
        this.emojiPickerOpen.set(false);
    }

    async onFilePicked(event: Event): Promise<void> {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';

        const detail = this.packDetail();
        if (!file || !detail || !this.canAddSticker()) {
            return;
        }

        const emoji = this.uploadEmoji().trim();
        if (!emoji) {
            this.uploadError.set('Give the sticker an emoji tag first.');
            return;
        }

        this.uploading.set(true);
        this.uploadError.set(null);
        try {
            const uploaded = await firstValueFrom(this.profileApi.upload(file, 'sticker'));
            const sticker = await firstValueFrom(
                this.stickerApi.addSticker(detail.id, { image_url: uploaded.url, emoji })
            );
            this.packDetail.set({ ...detail, stickers: [...detail.stickers, sticker] });
            this.uploadEmoji.set('');
            await this.loadPacks();
        } catch {
            this.uploadError.set('Could not add that sticker.');
        } finally {
            this.uploading.set(false);
        }
    }

    async deleteSticker(sticker: Sticker): Promise<void> {
        const detail = this.packDetail();
        if (!detail) {
            return;
        }

        this.busyStickerId.set(sticker.id);
        try {
            await firstValueFrom(this.stickerApi.deleteSticker(detail.id, sticker.id));
            this.packDetail.set({ ...detail, stickers: detail.stickers.filter((s) => s.id !== sticker.id) });
            await this.loadPacks();
        } catch {
            this.uploadError.set('Could not delete that sticker.');
        } finally {
            this.busyStickerId.set(null);
        }
    }

    async move(sticker: Sticker, direction: -1 | 1): Promise<void> {
        const detail = this.packDetail();
        if (!detail) {
            return;
        }

        const stickers = [...detail.stickers];
        const index = stickers.findIndex((s) => s.id === sticker.id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= stickers.length) {
            return;
        }

        [stickers[index], stickers[target]] = [stickers[target], stickers[index]];
        this.packDetail.set({ ...detail, stickers });

        this.busyStickerId.set(sticker.id);
        try {
            await firstValueFrom(
                this.stickerApi.reorderStickers(
                    detail.id,
                    stickers.map((s) => s.id)
                )
            );
        } catch {
            this.uploadError.set('Could not save the new order.');
            // Reload from the server rather than leaving a local order it never accepted.
            try {
                this.packDetail.set(await firstValueFrom(this.stickerApi.getPack(detail.id)));
            } catch {
                // Best-effort recovery only; the stale local order is still better than nothing.
            }
        } finally {
            this.busyStickerId.set(null);
        }
    }

    requestDeletePack(): void {
        this.confirmingDeletePack.set(true);
    }

    cancelDeletePack(): void {
        this.confirmingDeletePack.set(false);
    }

    async deletePack(): Promise<void> {
        const detail = this.packDetail();
        if (!detail) {
            return;
        }

        this.deletingPack.set(true);
        try {
            await firstValueFrom(this.stickerApi.deletePack(detail.id));
            this.expandedPackId.set(null);
            this.packDetail.set(null);
            this.confirmingDeletePack.set(false);
            await this.loadPacks();
        } catch {
            this.error.set('Could not delete that pack.');
        } finally {
            this.deletingPack.set(false);
        }
    }

    async goToDiscovery(): Promise<void> {
        await this.router.navigate(['/stickers/discover']);
    }

    async close(): Promise<void> {
        await this.router.navigate(['/chats']);
    }
}
