import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
    buildChatExport,
    collectExportUserIds,
    exportFileName,
    ExportInput,
    ExportPollVotes,
    isReadable,
    serializeExport,
} from '../export/chat-export';
import { ChatKeys } from '../models/crypto.model';
import { ChatApiService } from './chat-api.service';
import { ChatStoreService } from './chat-store.service';
import { CryptoApiService } from './crypto-api.service';
import { isCryptoNotEnabled } from './crypto-errors';
import { DirectoryService } from './directory.service';
import { contentOf, DecryptedMessage, MessageService } from './message.service';
import { PollStoreService } from './poll-store.service';

const PAGE_SIZE = 50;

export class ExportCancelledError extends Error {
    constructor() {
        super('export cancelled');
    }
}

export interface ExportProgress {
    phase: 'messages' | 'polls' | 'finishing';
    /** Messages decrypted so far (or polls tallied, in the polls phase). */
    done: number;
    /** Known only for polls; the history length is not known up front. */
    total: number | null;
}

export interface ExportResult {
    json: string;
    fileName: string;
    messageCount: number;
    /** Messages included only by status because they could not be decrypted. */
    unreadableCount: number;
    /** Polls whose vote list is incomplete (fetch failed, truncated, or unreadable votes). */
    incompletePolls: number;
}

/**
 * Exports a whole chat as JSON, entirely on this device.
 *
 * It pages through the ordinary history endpoint and decrypts through the same `MessageService` path
 * the conversation uses, so it can read exactly what the user can read - the history floor is
 * respected by construction, because the server never returns what it withheld. All decrypted
 * messages are held in memory until the file is built; see docs/tech-debt.md for what that means for
 * very large chats.
 */
@Injectable({ providedIn: 'root' })
export class ChatExportService {
    private readonly chatApi = inject(ChatApiService);
    private readonly cryptoApi = inject(CryptoApiService);
    private readonly messages = inject(MessageService);
    private readonly polls = inject(PollStoreService);
    private readonly directory = inject(DirectoryService);
    private readonly store = inject(ChatStoreService);

    async run(
        chatId: string,
        onProgress: (progress: ExportProgress) => void = () => undefined,
        signal?: AbortSignal
    ): Promise<ExportResult> {
        const cancelled = () => signal?.aborted === true;
        const check = () => {
            if (cancelled()) {
                throw new ExportCancelledError();
            }
        };

        const chat = await firstValueFrom(this.chatApi.getChat(chatId));
        const listed = this.store.chats().find((c) => c.id === chatId);
        const title = listed?.title ?? chat.title;
        check();

        const keys = chat.chat_type === 'channel' ? null : await this.tryKeys(chatId);
        check();

        // Pages arrive newest-first; each page is ascending. Collected per page, joined at the end.
        const pages: DecryptedMessage[][] = [];
        let before: string | undefined;
        let done = 0;
        for (;;) {
            check();
            const { raw, messages } = await this.messages.loadMessages(chatId, PAGE_SIZE, before, keys);
            if (raw.length === 0) {
                break;
            }
            pages.push(messages);
            done += messages.length;
            onProgress({ phase: 'messages', done, total: null });
            before = messages[0]?.id;
            if (raw.length < PAGE_SIZE || !before) {
                break;
            }
        }
        const all = pages.reverse().flat();

        // Votes for every poll in the history.
        const pollVotes = new Map<string, ExportPollVotes>();
        // The same readability rule the builder uses, so a poll is never listed without being tallied.
        const pollMessages = all.filter((m) => contentOf(m).kind === 'poll' && isReadable(m.status));
        let tallied = 0;
        for (const poll of pollMessages) {
            check();
            onProgress({ phase: 'polls', done: tallied, total: pollMessages.length });
            try {
                const { controls, truncated } = await this.polls.fetchControls(chatId, poll.id, cancelled);
                // A cancel can cut the fetch short; surface it rather than tallying a partial list.
                check();
                pollVotes.set(poll.id, { controls, failed: false, truncated });
            } catch (error) {
                if (error instanceof ExportCancelledError) {
                    throw error;
                }
                // Never an empty list passed off as "no votes": the file marks this poll incomplete.
                pollVotes.set(poll.id, { controls: [], failed: true, truncated: false });
            }
            tallied += 1;
        }
        check();
        onProgress({ phase: 'finishing', done: all.length, total: null });

        await this.directory.resolveMissing(
            collectExportUserIds(
                all,
                chat.participants.map((p) => p.user_id),
                pollVotes
            )
        );

        const exportedAt = new Date();
        const input: ExportInput = {
            chat: { id: chat.id, type: chat.chat_type, title },
            participants: chat.participants.map((p) => ({ userId: p.user_id, role: p.role })),
            messages: all,
            nameOf: (id) => this.directory.lookup(id).name,
            pollVotes,
            memberIds: chat.participants.length > 0 ? new Set(chat.participants.map((p) => p.user_id)) : null,
            historyFloor: this.hasHistoryFloor(keys),
            exportedAt,
        };
        const document = buildChatExport(input);

        return {
            json: serializeExport(document),
            fileName: exportFileName(title, exportedAt),
            messageCount: document.message_count,
            unreadableCount: document.unreadable_count,
            incompletePolls: document.messages.filter((m) => m.poll && !m.poll.votes_complete).length,
        };
    }

    /** Hand the file to the browser through a short-lived object URL (the CSP allows `blob:`). */
    download(json: string, fileName: string): void {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        try {
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            link.rel = 'noopener';
            document.body.appendChild(link);
            link.click();
            link.remove();
        } finally {
            // Revoked after the click has been dispatched; the download keeps its own reference.
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    private async tryKeys(chatId: string): Promise<ChatKeys | null> {
        try {
            return await firstValueFrom(this.cryptoApi.getChatKeys(chatId));
        } catch (error) {
            if (isCryptoNotEnabled(error)) {
                return null;
            }
            throw error;
        }
    }

    private hasHistoryFloor(keys: ChatKeys | null): boolean {
        if (!keys || keys.history_visibility !== 'joined' || keys.my_join_epoch === null) {
            return false;
        }
        return keys.epochs.some((epoch) => epoch.epoch < keys.my_join_epoch!);
    }
}
