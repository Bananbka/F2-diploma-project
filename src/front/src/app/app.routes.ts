import { Routes } from '@angular/router';

import { authGuard, guestGuard, unlockGuard } from './core/guards/session.guards';

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
        path: 'settings/profile',
        canActivate: [authGuard],
        loadComponent: () => import('./features/settings/profile/profile.component').then((m) => m.ProfileComponent),
    },
    {
        path: 'settings/password',
        canActivate: [authGuard],
        loadComponent: () =>
            import('./features/settings/change-password/change-password.component').then(
                (m) => m.ChangePasswordComponent
            ),
    },
    // The full-screen views come before the shell route. The shell matches on an empty path, so
    // leaving them below it would rely on the router backtracking out of a parent whose children all
    // failed — which works, but is a subtle thing to depend on.
    {
        path: 'new/group',
        canActivate: [authGuard],
        loadComponent: () =>
            import('./features/chat/create-group/create-group.component').then((m) => m.CreateGroupComponent),
    },
    {
        path: 'new/channel',
        canActivate: [authGuard],
        loadComponent: () =>
            import('./features/chat/create-channel/create-channel.component').then((m) => m.CreateChannelComponent),
    },
    {
        path: 'chats/:chatId/info',
        canActivate: [authGuard],
        loadComponent: () => import('./features/chat/chat-info/chat-info.component').then((m) => m.ChatInfoComponent),
    },
    {
        // The safety number is the only defence against the server substituting a public key, so it
        // gets a real route: reachable, linkable and bookmarkable rather than buried in a menu.
        path: 'chats/:chatId/safety/:userId',
        canActivate: [authGuard],
        loadComponent: () =>
            import('./features/chat/safety-number/safety-number.component').then((m) => m.SafetyNumberComponent),
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
