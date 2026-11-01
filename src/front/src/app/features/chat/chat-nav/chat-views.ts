import { Chat } from '../../../core/models/chat.model';
import { Folder } from '../../../core/services/folder-api.service';

/** The built-in views over the chat list. Only what the data actually supports. */
export type SystemViewId = 'all' | 'direct' | 'group' | 'channel' | 'unread';

/** A view key: a system view id, or `folder:<id>`. */
export type ChatViewKey = SystemViewId | `folder:${string}`;

export const SYSTEM_VIEWS: readonly { id: SystemViewId; label: string }[] = [
    { id: 'all', label: 'All chats' },
    { id: 'direct', label: 'Direct' },
    { id: 'group', label: 'Groups' },
    { id: 'channel', label: 'Channels' },
    { id: 'unread', label: 'Unread' },
];

export function folderKey(folderId: string): ChatViewKey {
    return `folder:${folderId}`;
}

export function isFolderKey(key: ChatViewKey): key is `folder:${string}` {
    return key.startsWith('folder:');
}

/** A chat counts as unread when it has unseen messages or was flagged by hand. */
export function isUnread(chat: Chat): boolean {
    return chat.unread_count > 0 || chat.marked_unread === true;
}

/** What the badge next to a view shows: unseen messages, with a hand-flagged chat counting as one. */
export function unreadTotal(chats: readonly Chat[]): number {
    return chats.reduce(
        (sum, chat) => sum + (chat.unread_count > 0 ? chat.unread_count : chat.marked_unread ? 1 : 0),
        0
    );
}

export function inSystemView(chat: Chat, view: SystemViewId): boolean {
    switch (view) {
        case 'all':
            return true;
        case 'direct':
            return chat.chat_type === 'private';
        case 'group':
        case 'channel':
            return chat.chat_type === view;
        case 'unread':
            return isUnread(chat);
    }
}

export function chatsInFolder(chats: readonly Chat[], folder: Folder): Chat[] {
    const ids = new Set(folder.items.map((item) => item.chat_id));
    return chats.filter((chat) => ids.has(chat.id));
}

/** The chats a view shows, before search and ordering. A folder that no longer exists shows nothing. */
export function chatsInView(chats: readonly Chat[], key: ChatViewKey, folders: readonly Folder[]): Chat[] {
    if (isFolderKey(key)) {
        const folder = folders.find((f) => folderKey(f.id) === key);
        return folder ? chatsInFolder(chats, folder) : [];
    }
    return chats.filter((chat) => inSystemView(chat, key));
}
