import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { SessionService } from '../services/session.service';

async function settled(session: SessionService): Promise<void> {
    if (!session.isRestored()) {
        await session.restore();
    }
}

/**
 * Requires a signed-in account **and** an open key store.
 *
 * Both matter. A cookie alone gets you a chat list of undecryptable ciphertext, which would render
 * as a wall of failures rather than as the locked state it actually is.
 */
export const authGuard: CanActivateFn = async () => {
    const session = inject(SessionService);
    const router = inject(Router);

    await settled(session);

    if (!session.user()) {
        return router.createUrlTree(['/login']);
    }

    if (!session.isUnlocked()) {
        return router.createUrlTree(['/unlock']);
    }

    return true;
};

/** The unlock screen itself: signed in, keys still sealed. */
export const unlockGuard: CanActivateFn = async () => {
    const session = inject(SessionService);
    const router = inject(Router);

    await settled(session);

    if (!session.user()) {
        return router.createUrlTree(['/login']);
    }

    if (session.isUnlocked()) {
        return router.createUrlTree(['/chats']);
    }

    return true;
};

/** Keeps an already-signed-in user off the register/login screens. */
export const guestGuard: CanActivateFn = async () => {
    const session = inject(SessionService);
    const router = inject(Router);

    await settled(session);

    if (session.user()) {
        return router.createUrlTree([session.isUnlocked() ? '/chats' : '/unlock']);
    }

    return true;
};
