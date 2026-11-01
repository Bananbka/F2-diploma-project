import {
    Bell,
    BellOff,
    Eraser,
    Folder as FolderIcon,
    FolderPlus,
    LogOut,
    Mail,
    MailOpen,
    Pin,
    PinOff,
    Trash2,
} from 'lucide-angular';

import { Chat, ParticipantRole } from '../../../core/models/chat.model';
import { Folder } from '../../../core/services/folder-api.service';
import { ContextMenuEntry } from '../../../shared/ui/context-menu/context-menu.model';

const HOUR_MS = 3_600_000;

/** There is no distinct "forever" server-side; a timestamp far enough away is how it is expressed. */
const FOREVER_YEARS = 100;

export interface ChatMenuActions {
    pin(chat: Chat, pinned: boolean): void;
    markUnread(chat: Chat, marked: boolean): void;
    /** `null` unmutes. */
    mute(chat: Chat, until: string | null): void;
    toggleFolder(folder: Folder, chat: Chat): void;
    clearHistory(chat: Chat): void;
    leave(chat: Chat): void;
    remove(chat: Chat): void;
}

export interface ChatMenuContext {
    chat: Chat;
    folders: readonly Folder[];
    /** The caller's role from the list (`my_role`), or `null` when unknown. */
    role: ParticipantRole | null;
    /** This chat is open right now, so it is being read and cannot sensibly be flagged unread. */
    isActive?: boolean;
    actions: ChatMenuActions;
    now?: () => number;
}

/**
 * The context menu of one chat-list row, built only from what the server will actually accept.
 *
 * Private chats can neither be left nor deleted (deleting one would destroy the other person's copy
 * on a decision they were not party to), so those two items are simply absent there. A known owner
 * cannot leave, so they get Delete instead. An unknown role gets neither: guessing Leave for an owner
 * produces a refusal, and guessing Delete for a member is not something to risk.
 */
export function buildChatMenu(context: ChatMenuContext): ContextMenuEntry[] {
    const { chat, folders, role, actions } = context;
    const now = context.now ?? Date.now;
    const pinned = chat.is_pinned === true;
    const muted = chat.is_muted;
    const entries: ContextMenuEntry[] = [];

    entries.push(
        pinned
            ? { icon: PinOff, label: 'Unpin', action: () => actions.pin(chat, false) }
            : { icon: Pin, label: 'Pin', action: () => actions.pin(chat, true) }
    );

    const muteFor = (hours: number): string => new Date(now() + hours * HOUR_MS).toISOString();
    const forever = new Date(now());
    forever.setFullYear(forever.getFullYear() + FOREVER_YEARS);

    entries.push({
        icon: muted ? Bell : BellOff,
        label: 'Mute notifications',
        children: [
            ...(muted ? [{ icon: Bell, label: 'Unmute', action: () => actions.mute(chat, null) }] : []),
            { label: 'For 1 hour', action: () => actions.mute(chat, muteFor(1)) },
            { label: 'For 8 hours', action: () => actions.mute(chat, muteFor(8)) },
            { label: 'For 2 days', action: () => actions.mute(chat, muteFor(48)) },
            { label: 'Forever', action: () => actions.mute(chat, forever.toISOString()) },
        ],
    });

    // "Mark as read" is only offered for the manual flag. Reading what is genuinely unread means
    // reading it, and a menu item cannot honestly claim that happened.
    if (chat.marked_unread) {
        entries.push({ icon: MailOpen, label: 'Mark as read', action: () => actions.markUnread(chat, false) });
    } else if (chat.unread_count === 0) {
        const reason = context.isActive
            ? 'This chat is open, so it is being read.'
            : chat.last_message === null
              ? 'There are no messages to come back to.'
              : undefined;
        entries.push({
            icon: Mail,
            label: 'Mark as unread',
            disabled: reason !== undefined,
            disabledReason: reason,
            action: () => actions.markUnread(chat, true),
        });
    }

    entries.push(
        folders.length > 0
            ? {
                  icon: FolderPlus,
                  label: 'Add to folder',
                  children: folders.map((folder) => ({
                      icon: FolderIcon,
                      label: folder.title,
                      checked: folder.items.some((item) => item.chat_id === chat.id),
                      action: () => actions.toggleFolder(folder, chat),
                  })),
              }
            : {
                  icon: FolderPlus,
                  label: 'Add to folder',
                  disabled: true,
                  disabledReason: 'You have no folders yet. Create one from the + button.',
              }
    );

    entries.push({ separator: true });
    entries.push({ icon: Eraser, label: 'Clear history', action: () => actions.clearHistory(chat) });

    if (chat.chat_type !== 'private' && role !== null) {
        const noun = chat.chat_type === 'channel' ? 'channel' : 'group';
        entries.push(
            role === 'owner'
                ? { icon: Trash2, label: `Delete ${noun}`, danger: true, action: () => actions.remove(chat) }
                : { icon: LogOut, label: `Leave ${noun}`, danger: true, action: () => actions.leave(chat) }
        );
    }

    return entries;
}
