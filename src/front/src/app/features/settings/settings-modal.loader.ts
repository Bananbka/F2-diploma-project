import { InjectionToken, Type } from '@angular/core';

/**
 * How the settings dialog's code is fetched. A token so that a failed download can be simulated in
 * specs; the default is the one dynamic import that keeps the dialog out of the main bundle.
 */
export const SETTINGS_MODAL_LOADER = new InjectionToken<() => Promise<Type<unknown>>>('SETTINGS_MODAL_LOADER', {
    providedIn: 'root',
    factory: () => () =>
        import('./settings-modal/settings-modal.component').then((m) => m.SettingsModalComponent as Type<unknown>),
});
