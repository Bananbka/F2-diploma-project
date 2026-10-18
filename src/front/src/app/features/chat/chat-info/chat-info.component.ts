import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
    ArrowLeft,
    Bell,
    BellOff,
    BookmarkPlus,
    Check,
    ChevronRight,
    Copy,
    Crown,
    Link,
    LogOut,
    LucideAngularModule,
    Search,
    Shield,
    ShieldAlert,
    ShieldCheck,
    ShieldOff,
    Trash2,
    UserMinus,
    UserPlus,
    X,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { computeMemberSetHash } from '../../../core/crypto/grants';
import { verifyIdentityBinding, verifySignedPrekey } from '../../../core/crypto/identity';
import { b64uDecode } from '../../../core/crypto/primitives';
import { Chat, InviteLink, ParticipantRole, UserSearchResult } from '../../../core/models/chat.model';
import { ChatRoster } from '../../../core/models/crypto.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { ContactsApiService } from '../../../core/services/contacts-api.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { SessionService } from '../../../core/services/session.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { safetyNumberGroups } from '../../../shared/utils/display';

interface MemberRow {
    userId: string;
    name: string;
    username: string | null;
    avatarUrl: string | null;
    resolved: boolean;
    role: ParticipantRole | null;
    isMe: boolean;
    /** True when the roster publishes an identity key for this member's device. */
    hasKeys: boolean;
}

@Component({
    selector: 'app-chat-info',
    imports: [RouterLink, LucideAngularModule, AvatarComponent, DatePipe],
    templateUrl: './chat-info.component.html',
    styleUrl: './chat-info.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatInfoComponent {
    private readonly chatApi = inject(ChatApiService);
    private readonly contactsApi = inject(ContactsApiService);
    private readonly cryptoApi = inject(CryptoApiService);
    private readonly directory = inject(DirectoryService);
    private readonly session = inject(SessionService);
    private readonly store = inject(ChatStoreService);
    private readonly router = inject(Router);

    readonly chatId = input.required<string>();

    readonly chat = signal<Chat | null>(null);
    readonly roster = signal<ChatRoster | null>(null);
    readonly safetyNumber = signal<string | null>(null);
    readonly loading = signal(true);
    readonly error = signal<string | null>(null);
    readonly busy = signal(false);

    readonly addOpen = signal(false);
    readonly addQuery = signal('');
    readonly addResults = signal<UserSearchResult[]>([]);
    /** Ids saved as contacts during this visit, so the action can confirm itself. */
    readonly contacted = signal(new Set<string>());

    private addTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * The anti-ghost check, run here as well as before key distribution.
     *
     * Two independent things, both required — the same pair `KeyStoreService.verifyRoster` enforces
     * before wrapping. This screen shows the roster, so it is where a failure has to be visible.
     *
     * **The binding signatures.** Each entry's X25519 key must be vouched for by that device's own
     * Ed25519 signing key — the key a peer pins out of band as a safety number. This is the actual
     * root of trust; without it the roster is merely what the server says it is.
     *
     * **The member set hash**, recomputed from the whole roster entry and compared against the
     * epoch's stored commitment. Note `roster.members`, not `members.map(m => m.device_id)`: the
     * commitment binds the key material now, precisely because hashing ids alone let a server keep
     * the device set identical and swap one member's public key for its own.
     */
    readonly memberSetVerified = computed(() => {
        const roster = this.roster();
        if (!roster) {
            return null;
        }

        const bindingsValid = roster.members.every((member) => {
            const signingPublic = b64uDecode(member.signing_public_key);

            const identityBound = verifyIdentityBinding(
                member.user_id,
                member.device_id,
                b64uDecode(member.identity_public_key),
                signingPublic,
                b64uDecode(member.identity_key_signature)
            );

            if (!identityBound) {
                return false;
            }

            if (!member.signed_prekey_public) {
                return true;
            }

            return (
                !!member.signed_prekey_signature &&
                verifySignedPrekey(
                    member.user_id,
                    member.device_id,
                    b64uDecode(member.signed_prekey_public),
                    signingPublic,
                    b64uDecode(member.signed_prekey_signature)
                )
            );
        });

        return bindingsValid && computeMemberSetHash(roster.members) === roster.member_set_hash;
    });

    readonly isPrivate = computed(() => this.chat()?.chat_type === 'private');
    readonly isChannel = computed(() => this.chat()?.chat_type === 'channel');

    /**
     * The name to show for this chat.
     *
     * `GET /chats/{id}` returns the raw `Chat.title` column, which is NULL for every private chat —
     * the counterpart's name is only computed by the list endpoint's `enrich_chats_with_mongo_data`.
     * So for a private chat the title comes from the other participant instead, which is what the
     * user actually thinks of as the chat's name.
     */
    readonly title = computed(() => {
        const chat = this.chat();
        if (!chat) {
            return '';
        }

        if (chat.chat_type === 'private') {
            // The chat list *does* carry the resolved counterpart name, so prefer it and fall back
            // to the directory only when this screen was opened without the list loaded.
            const fromList = this.store.chats().find((c) => c.id === chat.id)?.title;
            if (fromList) {
                return fromList;
            }

            const peer = chat.participants.find((p) => p.user_id !== this.session.user()?.id);
            return peer ? this.directory.lookup(peer.user_id).name : 'Private chat';
        }

        return chat.title ?? (chat.chat_type === 'channel' ? 'Channel' : 'Untitled group');
    });

    readonly members = computed<MemberRow[]>(() => {
        const chat = this.chat();
        const roster = this.roster();
        if (!chat) {
            return [];
        }

        const keyed = new Set(roster?.members.map((m) => m.user_id) ?? []);
        const me = this.session.user()?.id;

        return chat.participants.map((participant) => {
            const identity = this.directory.lookup(participant.user_id);
            return {
                userId: participant.user_id,
                name: identity.name,
                username: identity.username,
                avatarUrl: identity.avatarUrl,
                resolved: identity.resolved,
                role: participant.role,
                isMe: participant.user_id === me,
                hasKeys: keyed.has(participant.user_id),
            };
        });
    });

    readonly peerId = computed(() => this.members().find((m) => !m.isMe)?.userId ?? null);
    readonly membersWithoutKeys = computed(() => this.members().filter((m) => !m.hasKeys).length);
    readonly safetyPreview = computed(() => safetyNumberGroups(this.safetyNumber() ?? '').slice(0, 3));

    /** Only an owner or admin may change membership; the API rejects a member outright. */
    readonly canManage = computed(() => {
        const me = this.members().find((m) => m.isMe);
        return me?.role === 'owner' || me?.role === 'admin';
    });

    /** Transferring ownership and deleting the chat are the owner's alone. */
    readonly isOwner = computed(() => this.members().find((m) => m.isMe)?.role === 'owner');

    /**
     * An owner cannot leave — the server refuses, because a chat with no owner has nobody who can
     * ever delete it or hand it on. Saying so up front is better than letting them press Leave and
     * receive a refusal with no indication of what to do instead.
     */
    readonly ownerMustTransferFirst = computed(() => this.isOwner() && !this.isPrivate());

    /**
     * Which destructive action is armed, if any: `delete`, `owner:<userId>`, or `revoke:<linkId>`.
     *
     * A two-step press rather than `window.confirm`. The native dialog is unstyled, sits outside
     * the app's own language, and is suppressible by the browser — a poor fit for the actions here
     * that cannot be undone.
     */
    readonly confirming = signal<string | null>(null);

    readonly arrowLeftIcon = ArrowLeft;
    readonly chevronRightIcon = ChevronRight;
    readonly shieldIcon = Shield;
    readonly shieldCheckIcon = ShieldCheck;
    readonly shieldAlertIcon = ShieldAlert;
    readonly shieldOffIcon = ShieldOff;
    readonly logOutIcon = LogOut;
    readonly trashIcon = Trash2;
    readonly userMinusIcon = UserMinus;
    readonly userPlusIcon = UserPlus;
    readonly searchIcon = Search;
    readonly bookmarkIcon = BookmarkPlus;
    readonly checkIcon = Check;
    readonly crownIcon = Crown;
    readonly xIcon = X;
    readonly bellIcon = Bell;
    readonly bellOffIcon = BellOff;
    readonly linkIcon = Link;
    readonly copyIcon = Copy;

    /**
     * Active invite links for this chat, ADMIN/OWNER only. `is_active` filters revoked/expired/
     * used-up links out client-side too, in case the server ever returns a link that just crossed
     * one of those thresholds between fetch and render.
     */
    readonly inviteLinks = signal<InviteLink[]>([]);
    readonly inviteLinksLoading = signal(false);
    readonly inviteBusy = signal(false);
    readonly inviteError = signal<string | null>(null);
    readonly activeInviteLinks = computed(() => this.inviteLinks().filter((l) => l.is_active));

    /** A couple of presets rather than a raw date/number input — this is a rare, low-stakes action. */
    readonly expiryPreset = signal<'none' | '1d' | '7d'>('none');
    readonly maxUsesPreset = signal<'none' | '1' | '10'>('none');

    /** The token just copied, so the button can say "Copied" briefly instead of nothing at all. */
    readonly copiedToken = signal<string | null>(null);
    private copiedTimer: ReturnType<typeof setTimeout> | null = null;

    /** Same gate as membership management — ADMIN/OWNER, and private chats have no invite links. */
    readonly canManageInvites = computed(() => this.canManage() && !this.isPrivate());

    /**
     * Indefinite, not a duration picker: the server has no "mute forever" flag, only a nullable
     * timestamp (`MuteChatRequest`), so an indefinite mute is expressed as a timestamp far enough
     * in the future. A hundred years is comfortably beyond "forever" for this app's purposes
     * without touching any date-math edge case a smaller offset might.
     */
    private static readonly INDEFINITE_MUTE_MS = 100 * 365 * 24 * 60 * 60 * 1000;

    /**
     * Read through the store's chat list rather than the local `chat` signal: `setMuted` updates
     * `store.chats`, and this stays in sync with the sidebar without a second round trip.
     */
    readonly isMuted = computed(() => {
        const fromStore = this.store.chats().find((c) => c.id === this.chatId())?.is_muted;
        return fromStore ?? false;
    });

    constructor() {
        effect(() => void this.load(this.chatId()));
    }

    private async load(chatId: string): Promise<void> {
        this.loading.set(true);
        this.error.set(null);

        try {
            // `GET /chats/{id}` is the only endpoint that populates participants — the list endpoint
            // returns plain dicts with no participants key at all.
            const chat = await firstValueFrom(this.chatApi.getChat(chatId));
            this.chat.set(chat);

            // The two endpoints hold complementary halves of the same fact: the list has the
            // counterpart's resolved name but no participants, the detail has participants but a NULL
            // title. Pairing them here teaches the directory a name it could not otherwise learn,
            // which is what stops DM messages rendering as "Member 1a2b3c4d".
            if (chat.chat_type === 'private') {
                const peer = chat.participants.find((p) => p.user_id !== this.session.user()?.id);
                const listTitle = this.store.chats().find((c) => c.id === chatId)?.title ?? null;
                if (peer) {
                    this.directory.rememberPrivateChatPeer(peer.user_id, listTitle, chat.avatar_url);
                }
            }

            if (chat.chat_type !== 'channel') {
                try {
                    this.roster.set(await firstValueFrom(this.cryptoApi.getRoster(chatId)));
                } catch {
                    this.roster.set(null);
                }
            }

            const peer = chat.participants.find((p) => p.user_id !== this.session.user()?.id);
            if (chat.chat_type === 'private' && peer) {
                try {
                    this.safetyNumber.set(await firstValueFrom(this.cryptoApi.getSafetyNumber(peer.user_id)));
                } catch {
                    this.safetyNumber.set(null);
                }
            }

            if (this.canManageInvites()) {
                await this.loadInviteLinks(chatId);
            }
        } catch {
            this.error.set('Could not load this chat.');
        } finally {
            this.loading.set(false);
        }
    }

    private async loadInviteLinks(chatId: string): Promise<void> {
        this.inviteLinksLoading.set(true);
        try {
            this.inviteLinks.set(await firstValueFrom(this.chatApi.listInviteLinks(chatId)));
        } catch {
            this.inviteLinks.set([]);
        } finally {
            this.inviteLinksLoading.set(false);
        }
    }

    private presetExpiresAt(): string | undefined {
        const preset = this.expiryPreset();
        if (preset === 'none') {
            return undefined;
        }
        const days = preset === '1d' ? 1 : 7;
        return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    private presetMaxUses(): number | undefined {
        const preset = this.maxUsesPreset();
        return preset === 'none' ? undefined : Number(preset);
    }

    async createInviteLink(): Promise<void> {
        this.inviteBusy.set(true);
        this.inviteError.set(null);
        try {
            const link = await firstValueFrom(
                this.chatApi.createInviteLink(this.chatId(), this.presetExpiresAt(), this.presetMaxUses())
            );
            this.inviteLinks.update((links) => [link, ...links]);
        } catch {
            this.inviteError.set('Could not create an invite link.');
        } finally {
            this.inviteBusy.set(false);
        }
    }

    /**
     * Revoke an invite link. Two-step like transferring ownership or deleting the chat: revoking is
     * irreversible, and unlike those two, a wrong tap here fires on the same row as "copy", right next
     * to it.
     */
    async revokeInviteLink(link: InviteLink): Promise<void> {
        if (this.confirming() !== `revoke:${link.id}`) {
            this.confirming.set(`revoke:${link.id}`);
            return;
        }

        this.confirming.set(null);
        this.inviteBusy.set(true);
        this.inviteError.set(null);
        try {
            const revoked = await firstValueFrom(this.chatApi.revokeInviteLink(link.token));
            this.inviteLinks.update((links) => links.map((l) => (l.id === revoked.id ? revoked : l)));
        } catch {
            this.inviteError.set('Could not revoke that invite link.');
        } finally {
            this.inviteBusy.set(false);
        }
    }

    inviteLinkUrl(link: InviteLink): string {
        return `${location.origin}/join/${link.token}`;
    }

    async copyInviteLink(link: InviteLink): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.inviteLinkUrl(link));
        } catch {
            this.inviteError.set('Could not copy the link.');
            return;
        }

        this.copiedToken.set(link.token);
        if (this.copiedTimer) {
            clearTimeout(this.copiedTimer);
        }
        this.copiedTimer = setTimeout(() => this.copiedToken.set(null), 2000);
    }

    /**
     * Only an owner may change roles, the target must not be you, and OWNER cannot be granted.
     *
     * All three are enforced server-side; mirroring them here is about not offering a control that
     * would be rejected. Private chats give both participants MEMBER and no OWNER, so this is
     * unreachable there by construction.
     */
    canChangeRole(member: MemberRow): boolean {
        return this.canManage() && !member.isMe && member.role !== 'owner' && !this.isPrivate();
    }

    /** Only the owner, and only to someone who is not already the owner. */
    canTransferTo(member: MemberRow): boolean {
        return this.isOwner() && !member.isMe && member.role !== 'owner' && !this.isPrivate();
    }

    /**
     * Hand the chat to someone else, demoting yourself to admin.
     *
     * Two-step rather than immediate: it is irreversible from this side — once done, only the new
     * owner can hand it back — and it is the precondition for an owner ever leaving the chat.
     */
    async transferOwnership(userId: string): Promise<void> {
        if (this.confirming() !== `owner:${userId}`) {
            this.confirming.set(`owner:${userId}`);
            return;
        }

        this.confirming.set(null);
        this.busy.set(true);
        try {
            await firstValueFrom(this.chatApi.transferOwnership(this.chatId(), userId));
            await this.load(this.chatId());
            await this.store.loadChats();
        } catch {
            this.error.set('Could not transfer ownership.');
        } finally {
            this.busy.set(false);
        }
    }

    /**
     * Delete the chat and every message in it, for everyone.
     *
     * Two-step for the obvious reason, and worded as "for everyone" rather than "delete chat":
     * the destructive scope is the thing a user is most likely to misjudge, since in most
     * messengers deleting a conversation only removes your own copy.
     */
    async deleteChat(): Promise<void> {
        if (this.confirming() !== 'delete') {
            this.confirming.set('delete');
            return;
        }

        this.confirming.set(null);
        this.busy.set(true);
        try {
            await firstValueFrom(this.chatApi.deleteChat(this.chatId()));
            this.store.activeChatId.set(null);
            await this.store.loadChats();
            await this.router.navigate(['/chats']);
        } catch {
            this.error.set('Could not delete this chat.');
        } finally {
            this.busy.set(false);
        }
    }

    cancelConfirm(): void {
        this.confirming.set(null);
    }

    async setRole(userId: string, role: ParticipantRole): Promise<void> {
        this.busy.set(true);
        try {
            await firstValueFrom(this.chatApi.changeRole(this.chatId(), userId, role));
            await this.load(this.chatId());
        } catch {
            this.error.set('Could not change that role.');
        } finally {
            this.busy.set(false);
        }
    }

    /**
     * Save someone as a contact.
     *
     * Worth having beyond convenience: the contact list is one of the few id-keyed name sources, so
     * adding one is what makes this person resolvable by name everywhere else.
     */
    async addContact(member: MemberRow): Promise<void> {
        this.busy.set(true);
        try {
            await firstValueFrom(this.contactsApi.addContact(member.userId, member.name));
            this.contacted.update((ids) => new Set(ids).add(member.userId));
            await this.directory.warm();
        } catch {
            this.error.set('Could not add that contact.');
        } finally {
            this.busy.set(false);
        }
    }

    async searchPeople(query: string): Promise<void> {
        this.addQuery.set(query);

        if (this.addTimer) {
            clearTimeout(this.addTimer);
        }
        if (query.trim().length < 2) {
            this.addResults.set([]);
            return;
        }

        this.addTimer = setTimeout(async () => {
            const existing = new Set(this.members().map((m) => m.userId));
            const found = await this.directory.search(query.trim(), 20);
            this.addResults.set(found.filter((p) => !existing.has(p.id)));
        }, 250);
    }

    /**
     * Add someone to the chat.
     *
     * Membership changes rotate the key epoch, so everyone re-mints a chain and the joiner is
     * covered by the new one. That is why this reloads the roster rather than patching it locally.
     */
    async addParticipant(person: UserSearchResult): Promise<void> {
        this.busy.set(true);
        try {
            await firstValueFrom(this.chatApi.addParticipants(this.chatId(), [person.id]));
            this.addQuery.set('');
            this.addResults.set([]);
            this.addOpen.set(false);
            await this.load(this.chatId());
            await this.store.loadChats();
        } catch {
            this.error.set('Could not add that person.');
        } finally {
            this.busy.set(false);
        }
    }

    async removeMember(userId: string): Promise<void> {
        this.busy.set(true);
        try {
            await firstValueFrom(this.chatApi.removeParticipants(this.chatId(), [userId]));
            await this.load(this.chatId());
            await this.store.loadChats();
        } catch {
            this.error.set('Could not remove that member.');
        } finally {
            this.busy.set(false);
        }
    }

    async leave(): Promise<void> {
        this.busy.set(true);
        try {
            await firstValueFrom(this.chatApi.leaveChat(this.chatId()));
            this.store.activeChatId.set(null);
            await this.store.loadChats();
            await this.router.navigate(['/chats']);
        } catch {
            this.error.set('Could not leave this chat.');
        } finally {
            this.busy.set(false);
        }
    }

    async back(): Promise<void> {
        await this.router.navigate(['/chats', this.chatId()]);
    }

    /** Mute is purely local, per-user state — no WebSocket event fires, and no one else sees it. */
    async toggleMute(): Promise<void> {
        const mutedUntil = this.isMuted()
            ? null
            : new Date(Date.now() + ChatInfoComponent.INDEFINITE_MUTE_MS).toISOString();
        await this.store.setMuted(this.chatId(), mutedUntil);
    }
}
