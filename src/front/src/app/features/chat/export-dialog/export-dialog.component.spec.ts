import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ChatExportService, ExportCancelledError, ExportResult } from '../../../core/services/chat-export.service';
import { ExportDialogComponent } from './export-dialog.component';

describe('ExportDialogComponent', () => {
    let fixture: ComponentFixture<ExportDialogComponent>;
    let exporter: jasmine.SpyObj<ChatExportService>;

    const result = (overrides: Partial<ExportResult> = {}): ExportResult => ({
        json: '{}',
        fileName: 'chat.json',
        messageCount: 10,
        unreadableCount: 0,
        incompletePolls: 0,
        ...overrides,
    });

    function create(): HTMLElement {
        fixture = TestBed.createComponent(ExportDialogComponent);
        fixture.componentRef.setInput('chatId', 'chat');
        fixture.detectChanges();
        return fixture.nativeElement;
    }

    async function start(host: HTMLElement): Promise<void> {
        const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
            b.textContent!.includes('Export as JSON')
        )!;
        button.click();
        await fixture.whenStable();
        fixture.detectChanges();
    }

    beforeEach(() => {
        exporter = jasmine.createSpyObj<ChatExportService>('ChatExportService', ['run', 'download']);
        TestBed.configureTestingModule({
            imports: [ExportDialogComponent],
            providers: [{ provide: ChatExportService, useValue: exporter }],
        });
    });

    it('warns that the file holds decrypted content before anything runs', () => {
        const host = create();
        expect(host.textContent).toContain('decrypted');
        expect(exporter.run).not.toHaveBeenCalled();
    });

    it('says how many messages could not be read in the done state', async () => {
        exporter.run.and.resolveTo(result({ unreadableCount: 3 }));
        const host = create();

        await start(host);

        expect(exporter.download).toHaveBeenCalledOnceWith('{}', 'chat.json');
        expect(host.querySelector('.unreadable')!.textContent).toContain('3 messages could not be read');
    });

    it('says when poll counts may be incomplete', async () => {
        exporter.run.and.resolveTo(result({ incompletePolls: 2 }));
        const host = create();

        await start(host);

        expect(host.querySelector('.incomplete')!.textContent).toContain('2 polls may have incomplete vote counts');
    });

    it('says nothing about unreadable messages when there are none', async () => {
        exporter.run.and.resolveTo(result());
        const host = create();
        await start(host);
        expect(host.querySelector('.unreadable')).toBeNull();
    });

    it('saves nothing when cancelled', async () => {
        exporter.run.and.rejectWith(new ExportCancelledError());
        const host = create();

        await start(host);

        expect(exporter.download).not.toHaveBeenCalled();
        expect(host.textContent).toContain('Nothing was saved');
    });
});
