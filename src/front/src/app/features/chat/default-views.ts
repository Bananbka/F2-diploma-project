import { BookUser, Hash, LucideIconData, Mail, MessageSquare, User, Users } from 'lucide-angular';

import { HiddenViewId } from '../../core/models/appearance.model';
import { ChatViewKey, SystemViewId } from './chat-views';

export interface DefaultView {
    /** The name the appearance document uses for it. */
    id: HiddenViewId;
    /** The chat-list view it selects; null for Contacts, which is not a filter of the chat list. */
    chatView: SystemViewId | null;
    label: string;
    description: string;
    icon: LucideIconData;
}

/** The six built-in views, in rail order. */
export const DEFAULT_VIEWS: readonly DefaultView[] = [
    {
        id: 'all',
        chatView: 'all',
        label: 'All chats',
        description: 'Every conversation in one list.',
        icon: MessageSquare,
    },
    { id: 'direct', chatView: 'direct', label: 'Direct', description: 'One-to-one conversations.', icon: User },
    { id: 'groups', chatView: 'group', label: 'Groups', description: 'Group conversations.', icon: Users },
    { id: 'channels', chatView: 'channel', label: 'Channels', description: 'Broadcast channels.', icon: Hash },
    { id: 'unread', chatView: 'unread', label: 'Unread', description: 'Chats with unseen messages.', icon: Mail },
    { id: 'contacts', chatView: null, label: 'Contacts', description: 'People you have saved.', icon: BookUser },
];

/** Whether a view may be hidden: Contacts always, a chat view only while another chat view stays visible. */
export function canHideView(hidden: readonly HiddenViewId[], id: HiddenViewId): boolean {
    if (id === 'contacts') {
        return true;
    }
    const visibleChatViews = DEFAULT_VIEWS.filter((v) => v.chatView && !hidden.includes(v.id));
    return visibleChatViews.length > 1 || hidden.includes(id);
}

/** The first chat view that is not hidden (there is always one). */
export function firstVisibleChatView(hidden: readonly HiddenViewId[]): SystemViewId {
    return DEFAULT_VIEWS.find((v) => v.chatView && !hidden.includes(v.id))?.chatView ?? 'all';
}

/** True when the selected view is a built-in one that the user has hidden. */
export function isHiddenSelection(hidden: readonly HiddenViewId[], key: ChatViewKey): boolean {
    return DEFAULT_VIEWS.some((v) => v.chatView === key && hidden.includes(v.id));
}
