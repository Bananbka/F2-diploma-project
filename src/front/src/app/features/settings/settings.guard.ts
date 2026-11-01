import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { SettingsService, tabFromSegment } from './settings.service';

/** Where the dialog is allowed to simply appear over the current page without leaving it. */
const SHELL_URL = /^\/(chats(\/|\?|#|$)|\?|#|$)/;

/**
 * Deep links (`/settings/profile`, `/settings/password`, `/stickers/manage`) open the settings dialog
 * instead of rendering a page.
 *
 * - Followed from inside the app while the chat shell is showing (a "Create one" link in the sticker
 *   tray, say): the navigation is cancelled, so the URL and the open conversation stay exactly as
 *   they were and the dialog opens over them.
 * - Anywhere else, including a cold load of the link: redirect to `/chats`, which gives the dialog a
 *   chat shell to sit on; closing it leaves the user there.
 *
 * `data.tab` names the tab; an unknown value falls back to Profile.
 */
export const settingsDeepLinkGuard: CanActivateFn = (route) => {
    const settings = inject(SettingsService);
    const router = inject(Router);

    settings.open(tabFromSegment(route.data['tab'] ?? route.params['tab']));

    return router.navigated && SHELL_URL.test(router.url) ? false : router.parseUrl('/chats');
};
