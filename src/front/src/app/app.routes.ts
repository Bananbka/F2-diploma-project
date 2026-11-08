import { Routes } from '@angular/router';

import { authGuard, guestGuard, unlockGuard } from './core/guards/session.guards';
import { createDialogDeepLinkGuard } from './features/chat/create-dialog.service';
import { chatInfoDeepLinkGuard, safetyDeepLinkGuard } from './features/chat/info-dialog/info-dialog.service';
import { settingsDeepLinkGuard } from './features/settings/settings.guard';

export const routes: Routes = [
    {
        path: 'register',
        canActivate: [guestGuard],
        loadComponent: () => import('./features/auth/register/register.component').then((m) => m.RegisterComponent),
    },
    {
        path: 'verify',
        canActivate: [guestGuard],
        loadComponent: () =>
            import('./features/auth/verify-email/verify-email.component').then((m) => m.VerifyEmailComponent),
    },
    {
        path: 'login',
        canActivate: [guestGuard],
        loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent),
    },
    {
        path: 'forgot-password',
        canActivate: [guestGuard],
        loadComponent: () =>
            import('./features/auth/forgot-password/forgot-password.component').then((m) => m.ForgotPasswordComponent),
    },
    {
        path: 'reset-password',
        canActivate: [guestGuard],
        loadComponent: () =>
            import('./features/auth/reset-password/reset-password.component').then((m) => m.ResetPasswordComponent),
    },
    {
        // Signed in but sealed. Its own route because it is a distinct state, not a modal over the
        // chat list — nothing in the app works until the private bundle is open.
        path: 'unlock',
        canActivate: [unlockGuard],
        loadComponent: () => import('./features/auth/unlock/unlock.component').then((m) => m.UnlockComponent),
    },
    {
        // Settings is a dialog, not a page. These routes exist so the old links and bookmarks keep
        // working: the guard opens the dialog and either cancels the navigation or sends the user to
        // the chat shell for it to sit on. Nested under a pathless parent so `authGuard` runs first —
        // sibling guards on one route are evaluated together, and the dialog must not open for a
        // visitor who is about to be bounced to the login page.
        path: '',
        canActivate: [authGuard],
        children: [
            { path: 'settings', canActivate: [settingsDeepLinkGuard], data: { tab: 'profile' }, children: [] },
            { path: 'settings/:tab', canActivate: [settingsDeepLinkGuard], children: [] },
            { path: 'stickers/manage', canActivate: [settingsDeepLinkGuard], data: { tab: 'stickers' }, children: [] },
        ],
    },
    // The full-screen views come before the shell route. The shell matches on an empty path, so
    // leaving them below it would rely on the router backtracking out of a parent whose children all
    // failed — which works, but is a subtle thing to depend on.
    {
        path: 'stickers/discover',
        canActivate: [authGuard],
        loadComponent: () =>
            import('./features/chat/stickers/sticker-discovery/sticker-discovery.component').then(
                (m) => m.StickerDiscoveryComponent
            ),
    },
    {
        // Dialogs over the chat shell, not pages: the guard opens the dialog and keeps the user on the
        // shell (see `createDialogDeepLinkGuard`). Nested so `authGuard` runs first.
        path: '',
        canActivate: [authGuard],
        children: [
            { path: 'new/group', canActivate: [createDialogDeepLinkGuard], data: { kind: 'group' }, children: [] },
            {
                path: 'new/channel',
                canActivate: [createDialogDeepLinkGuard],
                data: { kind: 'channel' },
                children: [],
            },
        ],
    },
    {
        // What a shared invite link actually resolves to client-side. The server's own
        // `GET /invite-links/{token}` is path-addressed for the same shareable-link reason, but the
        // SPA never links straight at the API — this route calls it and renders the join decision.
        //
        // Guarded like every other route in this app (see CLAUDE.md: no anonymous routes at all),
        // which means an unauthenticated visitor is bounced to `/login` and the token is dropped —
        // there is no return-url mechanism anywhere in this app to preserve it through that round
        // trip. That is a known gap, not specific to this route.
        path: 'join/:token',
        canActivate: [authGuard],
        loadComponent: () =>
            import('./features/chat/join-invite/join-invite.component').then((m) => m.JoinInviteComponent),
    },
    {
        // Chat info and the safety number are dialogs over the chat shell, not pages. The guards open the
        // dialog and keep the user on the chat (see `chatInfoDeepLinkGuard`); the safety number is
        // still reachable and bookmarkable, it just appears over the conversation it is about. Nested
        // so `authGuard` runs first.
        path: '',
        canActivate: [authGuard],
        children: [
            { path: 'chats/:chatId/info', canActivate: [chatInfoDeepLinkGuard], children: [] },
            { path: 'chats/:chatId/safety/:userId', canActivate: [safetyDeepLinkGuard], children: [] },
        ],
    },
    {
        path: '',
        canActivate: [authGuard],
        loadComponent: () =>
            import('./features/chat/chat-shell/chat-shell.component').then((m) => m.ChatShellComponent),
        children: [
            {
                path: 'chats',
                loadComponent: () =>
                    import('./features/chat/chat-view/chat-view.component').then((m) => m.ChatViewComponent),
            },
            {
                path: 'chats/:chatId',
                loadComponent: () =>
                    import('./features/chat/chat-view/chat-view.component').then((m) => m.ChatViewComponent),
            },
            { path: '', pathMatch: 'full', redirectTo: 'chats' },
        ],
    },
    { path: '**', redirectTo: '' },
];
