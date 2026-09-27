import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { SuccessResponse } from '../models/api.model';
import { InviteLink, InviteLinkJoinResult, InviteLinkPreview } from '../models/chat.model';
import { ChatApiService } from './chat-api.service';
import { ConfigService } from './config.service';

const CHAT = 'a0000000-0000-4000-8000-000000000001';
const TOKEN = 'a-shareable-token';
const API_URL = 'http://api.test/';

function ok<T>(data: T): SuccessResponse<T> {
    return { status: 'success', data, meta: null };
}

function inviteLink(overrides: Partial<InviteLink> = {}): InviteLink {
    return {
        id: 'link-1',
        chat_id: CHAT,
        token: TOKEN,
        created_by: 'user-1',
        created_at: '2026-01-01T00:00:00Z',
        expires_at: null,
        max_uses: null,
        use_count: 0,
        revoked_at: null,
        is_active: true,
        ...overrides,
    };
}

describe('ChatApiService — invite links', () => {
    let service: ChatApiService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                { provide: ConfigService, useValue: { apiUrl: API_URL } },
            ],
        });

        service = TestBed.inject(ChatApiService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('creates an invite link, sending null for omitted bounds', () => {
        const link = inviteLink();
        let result: InviteLink | undefined;

        service.createInviteLink(CHAT).subscribe((r) => (result = r));

        const req = http.expectOne(`${API_URL}chats/${CHAT}/invite-links`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({ expires_at: null, max_uses: null });
        req.flush(ok(link));

        expect(result).toEqual(link);
    });

    it('creates an invite link with expiry and a use cap', () => {
        service.createInviteLink(CHAT, '2026-02-01T00:00:00Z', 5).subscribe();

        const req = http.expectOne(`${API_URL}chats/${CHAT}/invite-links`);
        expect(req.request.body).toEqual({ expires_at: '2026-02-01T00:00:00Z', max_uses: 5 });
        req.flush(ok(inviteLink()));
    });

    it('lists active invite links for a chat', () => {
        const links = [inviteLink(), inviteLink({ id: 'link-2', token: 'other' })];
        let result: InviteLink[] | undefined;

        service.listInviteLinks(CHAT).subscribe((r) => (result = r));

        const req = http.expectOne(`${API_URL}chats/${CHAT}/invite-links`);
        expect(req.request.method).toBe('GET');
        req.flush(ok(links));

        expect(result).toEqual(links);
    });

    it('previews a link by token in the URL path', () => {
        const preview: InviteLinkPreview = {
            chat_id: CHAT,
            chat_type: 'group',
            title: 'Dev Team',
            avatar_url: null,
            member_count: 4,
        };
        let result: InviteLinkPreview | undefined;

        service.previewInviteLink(TOKEN).subscribe((r) => (result = r));

        const req = http.expectOne(`${API_URL}invite-links/${TOKEN}`);
        expect(req.request.method).toBe('GET');
        req.flush(ok(preview));

        expect(result).toEqual(preview);
    });

    it('joins via token in the request body, not the URL', () => {
        const joinResult: InviteLinkJoinResult = { chat_id: CHAT, already_member: false };
        let result: InviteLinkJoinResult | undefined;

        service.joinInviteLink(TOKEN).subscribe((r) => (result = r));

        const req = http.expectOne(`${API_URL}invite-links/join`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({ token: TOKEN });
        req.flush(ok(joinResult));

        expect(result).toEqual(joinResult);
    });

    it('revokes via token in the request body, not the URL', () => {
        const revoked = inviteLink({ revoked_at: '2026-01-02T00:00:00Z', is_active: false });
        let result: InviteLink | undefined;

        service.revokeInviteLink(TOKEN).subscribe((r) => (result = r));

        const req = http.expectOne(`${API_URL}invite-links/revoke`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({ token: TOKEN });
        req.flush(ok(revoked));

        expect(result).toEqual(revoked);
    });
});
