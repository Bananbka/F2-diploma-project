import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { Eye, EyeOff, Key, LucideAngularModule } from 'lucide-angular';

import { ARGON2_MEMORY_KIB } from '../../../core/crypto/identity';
import { UnlockStage } from '../../../core/services/key-store.service';
import { SessionService } from '../../../core/services/session.service';

type Phase = 'input' | 'working' | 'done';

interface StageView {
    label: string;
    /** Where the bar sits *entering* this stage. Never interpolated — see the comment on `run`. */
    progress: number;
}

const STAGES: Record<UnlockStage, StageView> = {
    fetching: { label: 'Fetching your encrypted key bundle…', progress: 10 },
    deriving: { label: `Deriving key with Argon2id (${ARGON2_MEMORY_KIB / 1024} MiB)…`, progress: 35 },
    opening: { label: 'Opening the private bundle…', progress: 85 },
};

@Component({
    selector: 'app-unlock',
    imports: [ReactiveFormsModule, LucideAngularModule],
    templateUrl: './unlock.component.html',
    styleUrl: './unlock.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UnlockComponent {
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly fb = inject(FormBuilder);

    readonly phase = signal<Phase>('input');
    readonly showPassword = signal(false);
    readonly error = signal<string | null>(null);
    readonly provisioned = signal(false);

    private readonly stage = signal<UnlockStage>('fetching');

    readonly stageLabel = computed(() => (this.phase() === 'done' ? 'Keys ready' : STAGES[this.stage()].label));
    readonly progress = computed(() => (this.phase() === 'done' ? 100 : STAGES[this.stage()].progress));

    readonly form = this.fb.nonNullable.group({
        password: ['', Validators.required],
    });

    readonly eyeIcon = Eye;
    readonly eyeOffIcon = EyeOff;
    readonly keyIcon = Key;

    /**
     * Progress advances between real milestones only.
     *
     * Argon2id exposes no progress callback and runs synchronously on the main thread, so any
     * smoothly-animating bar here would be fabricated — and a fabricated bar on the one screen whose
     * slowness *is* the security property teaches the user to distrust it. Each stage is painted
     * before its work starts, which is what the double frame yield below buys.
     */
    async run(): Promise<void> {
        if (this.form.invalid || this.phase() === 'working') {
            this.form.markAllAsTouched();
            return;
        }

        const { password } = this.form.getRawValue();

        this.phase.set('working');
        this.error.set(null);
        this.stage.set('fetching');

        try {
            const outcome = await this.session.unlock(password, async (stage) => {
                this.stage.set(stage);
                await this.nextFrame();
            });

            if (outcome === 'wrong-password') {
                this.phase.set('input');
                this.error.set('That password did not open your keys.');
                this.form.reset();
                return;
            }

            this.provisioned.set(outcome === 'provisioned');
            this.phase.set('done');
            await this.nextFrame();
            await this.router.navigate(['/chats']);
        } catch {
            this.phase.set('input');
            this.error.set('Could not reach your keys. Check your connection and try again.');
        }
    }

    /** Two frames: one to flush the render, one to let the browser actually paint it. */
    private nextFrame(): Promise<void> {
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }
}
