import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';

import { Chat, Contact } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { ContactsStoreService } from '../../../core/services/contacts-store.service';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';
import { ContactsListComponent } from './contacts-list.component';

function contact(id: string, fullName: string, username: string, alias: string | null = null): Contact {
    return {
        owner_id: 'me',
        contact_id: id,
        alias_name: alias,
        user: { id, full_name: fullName, username, avatar_url: null },
    };
}

describe('ContactsListComponent', () => {
    let fixture: ComponentFixture<ContactsListComponent>;
    let host: HTMLElement;
    let store: {
        contacts: ReturnType<typeof signal<Contact[]>>;
        loading: ReturnType<typeof signal<boolean>>;
        error: ReturnType<typeof signal<string | null>>;
        load: jasmine.Spy;
        rename: jasmine.Spy;
        remove: jasmine.Spy;
    };
    let chatApi: jasmine.SpyObj<ChatApiService>;
    let confirm: jasmine.SpyObj<ConfirmService>;
    let router: Router;

    beforeEach(async () => {
        store = {
            contacts: signal([contact('u2', 'Bob Brown', 'bob'), contact('u1', 'Ada Lovelace', 'ada', 'Countess')]),
            loading: signal(false),
            error: signal<string | null>(null),
            load: jasmine.createSpy('load').and.resolveTo(),
            rename: jasmine.createSpy('rename').and.resolveTo(true),
            remove: jasmine.createSpy('remove').and.resolveTo(true),
        };
        chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['createPrivateChat']);
        chatApi.createPrivateChat.and.returnValue(of({ id: 'chat-9' } as unknown as Chat));
        confirm = jasmine.createSpyObj<ConfirmService>('ConfirmService', ['ask']);
        confirm.ask.and.resolveTo(true);

        await TestBed.configureTestingModule({
            providers: [
                provideRouter([]),
                { provide: ContactsStoreService, useValue: store },
                { provide: ChatApiService, useValue: chatApi },
                { provide: ChatStoreService, useValue: { loadChats: () => Promise.resolve() } },
                { provide: ConfirmService, useValue: confirm },
            ],
        }).compileComponents();

        router = TestBed.inject(Router);
        spyOn(router, 'navigate').and.resolveTo(true);
        fixture = TestBed.createComponent(ContactsListComponent);
        fixture.detectChanges();
        host = fixture.nativeElement as HTMLElement;
    });

    const names = () => Array.from(host.querySelectorAll('.name')).map((el) => el.textContent?.trim());

    it('lists contacts by alias or name, sorted, with the username', () => {
        expect(names()).toEqual(['Bob Brown', 'Countess']);
        expect(host.textContent).toContain('@ada');
        expect(host.textContent).toContain('Ada Lovelace');
    });

    it('filters by alias, name or username', () => {
        const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
        input.value = 'countess';
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        expect(names()).toEqual(['Countess']);

        input.value = 'zzz';
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        expect(host.textContent).toContain('Nobody matches');
    });

    it('opens the private chat when a contact is clicked', async () => {
        host.querySelector<HTMLButtonElement>('button.row')!.click();
        await fixture.whenStable();
        expect(chatApi.createPrivateChat).toHaveBeenCalledWith('u2');
        expect(router.navigate).toHaveBeenCalledWith(['/chats', 'chat-9']);
    });

    it('renames through the store, sending the trimmed alias', async () => {
        const target = store.contacts()[0];
        fixture.componentInstance.startRename(target);
        fixture.componentInstance.draft.set('  Bobby ');
        await fixture.componentInstance.commitRename(target);
        expect(store.rename).toHaveBeenCalledWith(target, '  Bobby ');
    });

    it('does not call the store when the alias is unchanged or the edit is cancelled', async () => {
        const target = store.contacts()[1];
        fixture.componentInstance.startRename(target);
        await fixture.componentInstance.commitRename(target);
        expect(store.rename).not.toHaveBeenCalled();

        fixture.componentInstance.startRename(target);
        fixture.componentInstance.draft.set('Other');
        fixture.componentInstance.cancelRename();
        await fixture.componentInstance.commitRename(target);
        expect(store.rename).not.toHaveBeenCalled();
    });

    it('removes only after confirmation', async () => {
        const target = store.contacts()[0];
        confirm.ask.and.resolveTo(false);
        await fixture.componentInstance.remove(target);
        expect(store.remove).not.toHaveBeenCalled();

        confirm.ask.and.resolveTo(true);
        await fixture.componentInstance.remove(target);
        expect(store.remove).toHaveBeenCalledWith(target);
    });

    it('offers Message, Rename and Remove in the context menu', () => {
        const labels = fixture.componentInstance
            .menu(store.contacts()[0])()
            .map((e) => ('label' in e ? e.label : '---'));
        expect(labels).toEqual(['Message', 'Rename…', '---', 'Remove contact']);
    });

    it('shows an empty state with no contacts', () => {
        store.contacts.set([]);
        fixture.detectChanges();
        expect(host.textContent).toContain('No contacts yet');
    });
});
