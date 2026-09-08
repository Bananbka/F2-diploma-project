import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Hash, KeyRound, LogOut, LucideAngularModule, MessageSquare, Shield, User, Users } from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { BrandMarkComponent } from '../../../shared/ui/brand-mark/brand-mark.component';

export type ChatFilter = 'all' | 'group' | 'channel';

@Component({
    selector: 'app-navigation-rail',
    imports: [LucideAngularModule, AvatarComponent, BrandMarkComponent],
    templateUrl: './navigation-rail.component.html',
    styleUrl: './navigation-rail.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NavigationRailComponent {
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);

    readonly filter = input.required<ChatFilter>();
    readonly filterChange = output<ChatFilter>();
    /** Emitted by the shield: opens the safety number for whoever is on screen. */
    readonly securityRequested = output<void>();

    readonly menuOpen = signal(false);

    readonly user = this.session.user;

    readonly tabs = [
        { id: 'all' as const, label: 'Chats', icon: MessageSquare },
        { id: 'group' as const, label: 'Groups', icon: Users },
        { id: 'channel' as const, label: 'Channels', icon: Hash },
    ];

    readonly shieldIcon = Shield;
    readonly logOutIcon = LogOut;
    readonly userIcon = User;
    readonly keyIcon = KeyRound;

    async goTo(path: string[]): Promise<void> {
        this.menuOpen.set(false);
        await this.router.navigate(path);
    }

    async signOut(): Promise<void> {
        this.menuOpen.set(false);
        await this.session.logout();
        await this.router.navigate(['/login']);
    }
}
