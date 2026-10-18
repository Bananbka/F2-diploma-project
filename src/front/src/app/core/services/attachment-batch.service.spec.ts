import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { AttachmentBatchService } from './attachment-batch.service';
import { ChatApiService } from './chat-api.service';

/** Plain (padded) base64, matching what the server's `content_base64` field uses. */
function toBase64(text: string): string {
    return btoa(text);
}

describe('AttachmentBatchService', () => {
    let service: AttachmentBatchService;
    let httpMock: HttpTestingController;
    const batchUrl = 'http://test/api/files/attachments/batch';

    beforeEach(() => {
        const chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', [
            'attachmentObjectKey',
            'attachmentsBatchUrl',
        ]);
        chatApi.attachmentObjectKey.and.callFake((storedUrl: string) => storedUrl.split('/').pop() ?? '');
        chatApi.attachmentsBatchUrl.and.returnValue(batchUrl);

        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                { provide: ChatApiService, useValue: chatApi },
            ],
        });

        service = TestBed.inject(AttachmentBatchService);
        httpMock = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        httpMock.verify();
    });

    function bytesToString(buffer: ArrayBuffer): string {
        return new TextDecoder().decode(buffer);
    }

    it('coalesces multiple same-chat fetch() calls into one HTTP call', async () => {
        const first = service.fetch('chat1', 'https://minio/bucket/key-a');
        const second = service.fetch('chat1', 'https://minio/bucket/key-b');

        await Promise.resolve();
        const req = httpMock.expectOne(batchUrl);
        expect(req.request.method).toBe('POST');
        expect(req.request.body.chat_id).toBe('chat1');
        expect(new Set(req.request.body.object_keys)).toEqual(new Set(['key-a', 'key-b']));

        req.flush({
            status: 'ok',
            data: [
                {
                    object_key: 'key-a',
                    status: 'ok',
                    content_type: 'image/png',
                    content_base64: toBase64('AAA'),
                    content_length: 3,
                },
                {
                    object_key: 'key-b',
                    status: 'ok',
                    content_type: 'image/png',
                    content_base64: toBase64('BBB'),
                    content_length: 3,
                },
            ],
        });

        expect(bytesToString(await first)).toBe('AAA');
        expect(bytesToString(await second)).toBe('BBB');
    });

    it('splits more than 50 pending keys into multiple batch calls', async () => {
        const keys = Array.from({ length: 60 }, (_, i) => `key-${i}`);
        const promises = keys.map((key) => service.fetch('chat1', `https://minio/bucket/${key}`));

        // Let the microtask flush scheduling run before asserting on HttpTestingController.
        await Promise.resolve();

        const requests = httpMock.match(batchUrl);
        expect(requests.length).toBe(2);
        expect(requests[0].request.body.object_keys.length).toBe(50);
        expect(requests[1].request.body.object_keys.length).toBe(10);

        for (const req of requests) {
            req.flush({
                status: 'ok',
                data: (req.request.body.object_keys as string[]).map((key) => ({
                    object_key: key,
                    status: 'ok',
                    content_type: 'application/octet-stream',
                    content_base64: toBase64('X'),
                    content_length: 1,
                })),
            });
        }

        await Promise.all(promises);
    });

    it('resolves ok keys and rejects not_found/gone keys from the same response', async () => {
        const ok = service.fetch('chat1', 'https://minio/bucket/key-ok');
        const notFound = service.fetch('chat1', 'https://minio/bucket/key-missing');
        const gone = service.fetch('chat1', 'https://minio/bucket/key-gone');

        await Promise.resolve();
        const req = httpMock.expectOne(batchUrl);
        req.flush({
            status: 'ok',
            data: [
                {
                    object_key: 'key-ok',
                    status: 'ok',
                    content_type: 'image/png',
                    content_base64: toBase64('OK'),
                    content_length: 2,
                },
                {
                    object_key: 'key-missing',
                    status: 'not_found',
                    content_type: null,
                    content_base64: null,
                    content_length: null,
                },
                {
                    object_key: 'key-gone',
                    status: 'gone',
                    content_type: null,
                    content_base64: null,
                    content_length: null,
                },
            ],
        });

        expect(bytesToString(await ok)).toBe('OK');
        await expectAsync(notFound).toBeRejected();
        await expectAsync(gone).toBeRejected();
    });

    it('rejects every queued entry when the whole HTTP call fails', async () => {
        const first = service.fetch('chat1', 'https://minio/bucket/key-a');
        const second = service.fetch('chat1', 'https://minio/bucket/key-b');

        await Promise.resolve();
        const req = httpMock.expectOne(batchUrl);
        req.flush('boom', { status: 500, statusText: 'Server Error' });

        await expectAsync(first).toBeRejected();
        await expectAsync(second).toBeRejected();
    });

    it('never merges pending keys from different chats into one batch call', async () => {
        const a = service.fetch('chat1', 'https://minio/bucket/key-a');
        const b = service.fetch('chat2', 'https://minio/bucket/key-b');

        await Promise.resolve();
        await Promise.resolve();

        const requests = httpMock.match(batchUrl);
        expect(requests.length).toBe(2);
        const byChat = new Map(requests.map((req) => [req.request.body.chat_id as string, req]));
        expect(byChat.get('chat1')?.request.body.object_keys).toEqual(['key-a']);
        expect(byChat.get('chat2')?.request.body.object_keys).toEqual(['key-b']);

        byChat.get('chat1')?.flush({
            status: 'ok',
            data: [
                {
                    object_key: 'key-a',
                    status: 'ok',
                    content_type: 'image/png',
                    content_base64: toBase64('A'),
                    content_length: 1,
                },
            ],
        });
        byChat.get('chat2')?.flush({
            status: 'ok',
            data: [
                {
                    object_key: 'key-b',
                    status: 'ok',
                    content_type: 'image/png',
                    content_base64: toBase64('B'),
                    content_length: 1,
                },
            ],
        });

        await a;
        await b;
    });
});
