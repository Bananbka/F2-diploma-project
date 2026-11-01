import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { AppComponent } from './app.component';
import { ToastService } from './core/services/toast.service';
import { SettingsService } from './features/settings/settings.service';
import { SETTINGS_MODAL_LOADER } from './features/settings/settings-modal.loader';

@Component({
    selector: 'app-fake-settings',
    template: '<p id="fake-settings">settings</p>',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class FakeSettingsComponent {}

describe('AppComponent', () => {
    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppComponent],
            // The root component is now nothing but a router outlet, so it needs a router to render.
            providers: [provideRouter([])],
        }).compileComponents();
    });

    it('should create the app', () => {
        const fixture = TestBed.createComponent(AppComponent);
        expect(fixture.componentInstance).toBeTruthy();
    });

    it('should render a router outlet', () => {
        const fixture = TestBed.createComponent(AppComponent);
        fixture.detectChanges();
        const compiled = fixture.nativeElement as HTMLElement;
        expect(compiled.querySelector('router-outlet')).toBeTruthy();
    });

    describe('lazy settings dialog', () => {
        let loader: jasmine.Spy;

        function setup(): void {
            TestBed.resetTestingModule();
            TestBed.configureTestingModule({
                imports: [AppComponent],
                providers: [provideRouter([]), { provide: SETTINGS_MODAL_LOADER, useValue: loader }],
            });
        }

        it('loads the dialog on first open, showing a placeholder meanwhile', async () => {
            let release!: () => void;
            loader = jasmine
                .createSpy('loader')
                .and.callFake(() => new Promise((resolve) => (release = () => resolve(FakeSettingsComponent))));
            setup();
            const fixture = TestBed.createComponent(AppComponent);
            const root = fixture.nativeElement as HTMLElement;
            fixture.detectChanges();
            expect(loader).not.toHaveBeenCalled();

            TestBed.inject(SettingsService).open('profile');
            fixture.detectChanges();
            expect(root.querySelector('.settings-loading')?.textContent).toContain('Loading settings');

            release();
            await fixture.whenStable();
            fixture.detectChanges();
            expect(root.querySelector('#fake-settings')).toBeTruthy();
            expect(root.querySelector('.settings-loading')).toBeNull();
        });

        it('resets the open state and tells the user when the chunk fails, so the button can retry', async () => {
            loader = jasmine.createSpy('loader').and.rejectWith(new Error('chunk failed'));
            setup();
            const fixture = TestBed.createComponent(AppComponent);
            fixture.detectChanges();
            const settings = TestBed.inject(SettingsService);
            const toast = TestBed.inject(ToastService);
            spyOn(toast, 'error');

            settings.open('profile');
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();

            expect(settings.isOpen()).toBeFalse();
            expect(toast.error).toHaveBeenCalled();
            expect((fixture.nativeElement as HTMLElement).querySelector('.settings-loading')).toBeNull();

            loader.and.resolveTo(FakeSettingsComponent);
            settings.open('profile');
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();
            expect(loader).toHaveBeenCalledTimes(2);
            expect((fixture.nativeElement as HTMLElement).querySelector('#fake-settings')).toBeTruthy();
        });
    });
});
