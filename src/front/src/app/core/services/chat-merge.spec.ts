import { Chat } from '../models/chat.model';
import { MessageResponse } from '../models/crypto.model';
import { mergeChatDetail } from './chat-merge';

function chat(overrides: Partial<Chat>): Chat {
    return {
        id: 'c1',
        chat_type: 'private',
        title: null,
        avatar_url: null,
        unread_count: 0,
        last_message: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: null,
        participants: [],
        muted_until: null,
        is_muted: false,
        ...overrides,
    };
}

const LAST = { _id: 'm1' } as MessageResponse;

describe('mergeChatDetail', () => {
    it('keeps the list avatar, title and last message for a private chat', () => {
        const list = chat({ title: 'Zed', avatar_url: 'http://x/a.png', last_message: LAST, unread_count: 3 });
        const detail = chat({
            participants: [{ user_id: 'u', role: 'member', joined_at: '2024-01-01T00:00:00Z' }],
        });

        const merged = mergeChatDetail(list, detail);

        expect(merged.avatar_url).toBe('http://x/a.png');
        expect(merged.title).toBe('Zed');
        expect(merged.last_message).toBe(LAST);
        expect(merged.unread_count).toBe(3);
        expect(merged.participants.length).toBe(1);
    });

    it('does not let a null detail avatar blank the list avatar', () => {
        const merged = mergeChatDetail(chat({ avatar_url: 'http://x/a.png' }), chat({ avatar_url: null }));
        expect(merged.avatar_url).toBe('http://x/a.png');
    });

    it('takes a group avatar from the detail when the list lacks it', () => {
        const merged = mergeChatDetail(
            chat({ chat_type: 'group', avatar_url: null }),
            chat({ chat_type: 'group', avatar_url: 'http://x/g.png' })
        );
        expect(merged.avatar_url).toBe('http://x/g.png');
    });

    it('takes mute state from the detail, which is the fresher source', () => {
        const merged = mergeChatDetail(
            chat({ is_muted: true, muted_until: '2099-01-01T00:00:00Z' }),
            chat({ is_muted: false, muted_until: null })
        );
        expect(merged.is_muted).toBeFalse();
        expect(merged.muted_until).toBeNull();
    });

    it('takes the newer updated_at', () => {
        expect(
            mergeChatDetail(chat({ updated_at: '2026-02-01T00:00:00Z' }), chat({ updated_at: '2026-01-01T00:00:00Z' }))
                .updated_at
        ).toBe('2026-02-01T00:00:00Z');
        expect(
            mergeChatDetail(chat({ updated_at: null }), chat({ updated_at: '2026-01-01T00:00:00Z' })).updated_at
        ).toBe('2026-01-01T00:00:00Z');
    });

    it('keeps the deleted-peer flag from the list', () => {
        const merged = mergeChatDetail(chat({ peer_is_deleted: true }), chat({}));
        expect(merged.peer_is_deleted).toBeTrue();
    });

    it('returns the detail when the list does not know the chat', () => {
        const detail = chat({ title: 'T' });
        expect(mergeChatDetail(undefined, detail)).toBe(detail);
    });
});
