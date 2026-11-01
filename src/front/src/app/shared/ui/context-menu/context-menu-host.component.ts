import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { ContextMenuComponent } from './context-menu.component';
import { ContextMenuService } from './context-menu.service';

/**
 * The single overlay that renders whatever `ContextMenuService` has open. Mounted once, in the app
 * root. Tracking by the opening's id gives each menu a fresh component, so a replacement menu never
 * inherits the previous one's focus, listeners or measured position.
 */
@Component({
    selector: 'app-context-menu-host',
    imports: [ContextMenuComponent],
    template: `
        @for (menu of open(); track menu.id) {
            <app-context-menu
                [items]="menu.items"
                [anchor]="menu.anchor"
                [source]="menu.source"
                [trigger]="menu.trigger"
                (closed)="service.close($event)"
            />
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextMenuHostComponent {
    protected readonly service = inject(ContextMenuService);
    protected readonly open = computed(() => {
        const current = this.service.current();
        return current ? [current] : [];
    });
}
