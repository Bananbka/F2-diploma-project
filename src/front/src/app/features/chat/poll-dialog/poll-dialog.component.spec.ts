import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PollPayload } from '../../../core/models/message-payload';
import { PollDialogComponent } from './poll-dialog.component';

describe('PollDialogComponent', () => {
    let fixture: ComponentFixture<PollDialogComponent>;
    let component: PollDialogComponent;
    let host: HTMLElement;

    beforeEach(() => {
        TestBed.configureTestingModule({ imports: [PollDialogComponent] });
        fixture = TestBed.createComponent(PollDialogComponent);
        component = fixture.componentInstance;
        host = fixture.nativeElement;
        fixture.detectChanges();
    });

    function fill(): void {
        component.question.set('Lunch?');
        component.options.set(['Pizza', 'Sushi']);
        fixture.detectChanges();
    }

    it('cannot be sent empty', () => {
        expect(component.canSubmit()).toBeFalse();
        expect(component.problem()).toBeTruthy();
    });

    it('emits the validated poll', () => {
        fill();
        component.multiple.set(true);
        component.anonymous.set(true);
        const emitted: PollPayload[] = [];
        component.submitted.subscribe((p) => emitted.push(p));

        component.submit();

        expect(emitted).toEqual([
            { question: 'Lunch?', options: ['Pizza', 'Sushi'], multiple: true, anonymous: true, closesAt: null },
        ]);
    });

    it('keeps between 2 and 10 options', () => {
        fill();
        expect(component.canRemoveOption()).toBeFalse();
        for (let i = 0; i < 12; i++) {
            component.addOption();
        }
        expect(component.options().length).toBe(10);
        expect(component.canAddOption()).toBeFalse();
    });

    it('refuses duplicate options', () => {
        fill();
        component.setOption(1, 'pizza');
        expect(component.canSubmit()).toBeFalse();
        expect(component.problem()).toContain('different');
    });

    it('will not submit while sending is blocked', () => {
        fill();
        fixture.componentRef.setInput('blockedReason', 'Blocked.');
        const emitted: PollPayload[] = [];
        component.submitted.subscribe((p) => emitted.push(p));

        component.submit();

        expect(emitted).toEqual([]);
    });

    it('is honest that anonymity is interface-only', () => {
        const text = host.textContent!.replace(/\s+/g, ' ');
        expect(text).toContain(
            "Anonymous only in the interface: the server knows who voted, and other members' browsers can see it too. This app merely hides it."
        );
    });
});
