import { Chat } from '../../../core/models/chat.model';
import { Folder } from '../../../core/services/folder-api.service';
import { ContextMenuEntry, ContextMenuItem, isSeparator } from '../../../shared/ui/context-menu/context-menu.model';
import { buildChatMenu, ChatMenuActions } from './chat-menu';

function chat(overrides: Partial<Chat> = {}): Chat {
    return {
        id: 'c1',
        chat_type: 'group',
        title: 'Team',
        avatar_url: null,
        unread_count: 0,
        last_message: null,
        created_at: '',
        updated_at: null,
        participants: [],
        muted_until: null,
        is_muted: false,
        ...overrides,
    };
}

const FOLDERS: Folder[] = [
    { id: 'f1', title: 'Work', items: [{ chat_id: 'c1' }] },
    { id: 'f2', title: 'Home', items: [] },
];

function actions(): jasmine.SpyObj<ChatMenuActions> {
    return jasmine.createSpyObj<ChatMenuActions>('actions', [
        'pin',
        'markUnread',
        'mute',
        'toggleFolder',
        'clearHistory',
        'leave',
        'remove',
    ]);
}

function build(
    c: Chat,
    role: 'owner' | 'admin' | 'member' | null = 'member',
    folders: Folder[] = FOLDERS,
    isActive = false
) {
    const spy = actions();
    const entries = buildChatMenu({ chat: c, folders, role, isActive, actions: spy, now: () => Date.UTC(2026, 0, 1) });
    return { spy, entries };
}

const items = (entries: ContextMenuEntry[]): ContextMenuItem[] =>
    entries.filter((e): e is ContextMenuItem => !isSeparator(e));
const labelsOf = (entries: ContextMenuEntry[]) => items(entries).map((i) => i.label);

describe('buildChatMenu', () => {
    it('offers Pin, and Unpin once pinned', () => {
        expect(labelsOf(build(chat()).entries)[0]).toBe('Pin');
        expect(labelsOf(build(chat({ is_pinned: true })).entries)[0]).toBe('Unpin');
    });

    it('pins and unpins through the action', () => {
        const { spy, entries } = build(chat());
        items(entries)[0].action!();
        expect(spy.pin).toHaveBeenCalledWith(jasmine.objectContaining({ id: 'c1' }), true);
    });

    it('offers only what works in a private chat: no leave, no delete', () => {
        const labels = labelsOf(build(chat({ chat_type: 'private' }), null).entries);
        expect(labels).toContain('Clear history');
        expect(labels.some((l) => /leave|delete/i.test(l))).toBeFalse();
    });

    it('offers Leave for members and Delete for a known owner, with channel wording', () => {
        expect(labelsOf(build(chat(), 'member').entries)).toContain('Leave group');
        expect(labelsOf(build(chat(), null).entries).some((l) => /leave|delete/i.test(l)))
            .withContext('an unknown role must not be guessed')
            .toBeFalse();
        expect(labelsOf(build(chat(), 'owner').entries)).toContain('Delete group');
        expect(labelsOf(build(chat({ chat_type: 'channel' }), 'member').entries)).toContain('Leave channel');

        const leave = items(build(chat(), 'member').entries).find((i) => i.label === 'Leave group')!;
        expect(leave.danger).toBeTrue();
    });

    it('disables Mark as unread for the open chat and for a chat with no messages, with a reason', () => {
        const open = items(build(chat({ last_message: {} as never }), 'member', FOLDERS, true).entries).find(
            (i) => i.label === 'Mark as unread'
        )!;
        expect(open.disabled).toBeTrue();
        expect(open.disabledReason).toBeTruthy();

        const empty = items(build(chat()).entries).find((i) => i.label === 'Mark as unread')!;
        expect(empty.disabled).toBeTrue();

        const ok = items(build(chat({ last_message: {} as never })).entries).find((i) => i.label === 'Mark as unread')!;
        expect(ok.disabled).toBeFalsy();
    });

    it('offers Mark as unread only when nothing is unread, and Mark as read for the manual flag', () => {
        expect(labelsOf(build(chat()).entries)).toContain('Mark as unread');
        expect(labelsOf(build(chat({ unread_count: 4 })).entries)).not.toContain('Mark as unread');
        expect(labelsOf(build(chat({ unread_count: 4 })).entries)).not.toContain('Mark as read');
        expect(labelsOf(build(chat({ marked_unread: true })).entries)).toContain('Mark as read');
    });

    it('builds the mute submenu, with Unmute only while muted', () => {
        const { spy, entries } = build(chat());
        const mute = items(entries).find((i) => i.label === 'Mute notifications')!;
        expect(mute.children!.map((c) => (c as ContextMenuItem).label)).toEqual([
            'For 1 hour',
            'For 8 hours',
            'For 2 days',
            'Forever',
        ]);

        (mute.children![0] as ContextMenuItem).action!();
        expect(spy.mute).toHaveBeenCalledWith(jasmine.anything(), '2026-01-01T01:00:00.000Z');

        const muted = items(build(chat({ is_muted: true })).entries).find((i) => i.label === 'Mute notifications')!;
        const unmute = muted.children![0] as ContextMenuItem;
        expect(unmute.label).toBe('Unmute');
        unmute.action!();
    });

    it('lists folders with check marks for membership', () => {
        const folder = items(build(chat()).entries).find((i) => i.label === 'Add to folder')!;
        const [work, home] = folder.children as ContextMenuItem[];
        expect(work.checked).toBeTrue();
        expect(home.checked).toBeFalse();
    });

    it('disables Add to folder, with a reason, when there are no folders', () => {
        const folder = items(build(chat(), 'member', []).entries).find((i) => i.label === 'Add to folder')!;
        expect(folder.disabled).toBeTrue();
        expect(folder.disabledReason).toBeTruthy();
    });
});
