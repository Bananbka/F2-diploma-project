import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
    Hash,
    KeyRound,
    LogOut,
    LucideAngularModule,
    MessageSquare,
    Settings,
    Shield,
    User,
    Users,
} from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { BrandMarkComponent } from '../../../shared/ui/brand-mark/brand-mark.component';
import { SettingsService, SettingsTab } from '../../settings/settings.service';

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
    private readonly settings = inject(SettingsService);

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
    readonly settingsIcon = Settings;
    readonly logOutIcon = LogOut;
    readonly userIcon = User;
    readonly keyIcon = KeyRound;

    /**
     * Open the settings dialog. The opener is passed in because a click inside the account menu
     * closes the menu, which removes the very button focus would otherwise return to.
     */
    openSettings(tab: SettingsTab, opener: Event | HTMLElement): void {
        this.menuOpen.set(false);
        const element = opener instanceof Event ? (opener.currentTarget as HTMLElement) : opener;
        this.settings.open(tab, element);
    }

    async signOut(): Promise<void> {
        this.menuOpen.set(false);
        await this.session.logout();
        await this.router.navigate(['/login']);
    }
}
