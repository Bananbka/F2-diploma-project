import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { SuccessResponse } from '../models/api.model';
import { UserProfile } from '../models/chat.model';
import { ConfigService } from './config.service';

export interface RegisterRequest {
    full_name: string;
    username: string;
    password: string;
    email: string;
    phone_number: string;
    /** Legacy RSA fields, still required by the backend schema during the transition. */
    public_key: string;
    encrypted_private_key: string;
}

export interface LoginRequest {
    username: string;
    password: string;
}

/** Both are required: the account is found by username **and** email together, not either one. */
export interface ForgotPasswordRequest {
    username: string;
    email: string;
}

/**
 * Reset destroys the identity.
 *
 * There is deliberately no field for re-wrapped keys — the Argon2id bundle was sealed under the
 * forgotten password and is unrecoverable, so the server revokes every device instead. `new_public_key`
 * and `new_encrypted_private_key` are the legacy RSA columns, not the v1 identity.
 */
export interface ResetPasswordRequest {
    username: string;
    otp: string;
    new_password: string;
    new_public_key: string;
    new_encrypted_private_key: string;
}

/** One device's private bundle, re-sealed under the new password. */
export interface RewrappedIdentity {
    device_id: string;
    encrypted_private_bundle: string;
    kdf_params: Record<string, unknown>;
}

/**
 * Change keeps the identity, unlike reset.
 *
 * `rewrapped_identities` is optional to the server and unverifiable by it: omit it, or wrap it wrong,
 * and the account is locked out with a 200 OK. Callers must always supply it.
 */
export interface ChangePasswordRequest {
    old_password: string;
    new_password: string;
    rewrapped_identities: RewrappedIdentity[];
}

@Injectable({ providedIn: 'root' })
export class AuthApiService {
    private readonly http = inject(HttpClient);
    private readonly configService = inject(ConfigService);

    private get apiUrl(): string {
        return this.configService.apiUrl + 'auth/';
    }

    register(data: RegisterRequest): Observable<UserProfile> {
        return this.http.post<SuccessResponse<UserProfile>>(`${this.apiUrl}register`, data).pipe(map((r) => r.data));
    }

    /**
     * Re-issue the OTP.
     *
     * Takes no address: the endpoint reads the recipient from the (unverified) session that
     * `register` established, so a caller cannot aim verification mail at somebody else's inbox.
     */
    resendVerificationEmail(): Observable<unknown> {
        return this.http
            .post<SuccessResponse<unknown>>(`${this.apiUrl}get-verification-email`, {})
            .pipe(map((r) => r.data));
    }

    verifyEmail(email: string, otp: string): Observable<UserProfile> {
        return this.http
            .post<SuccessResponse<UserProfile>>(`${this.apiUrl}verify-email`, { email, otp })
            .pipe(map((r) => r.data));
    }

    login(data: LoginRequest): Observable<UserProfile> {
        return this.http.post<SuccessResponse<UserProfile>>(`${this.apiUrl}login`, data).pipe(map((r) => r.data));
    }

    logout(): Observable<unknown> {
        return this.http.post<SuccessResponse<unknown>>(`${this.apiUrl}logout`, {}).pipe(map((r) => r.data));
    }

    refresh(): Observable<unknown> {
        return this.http.post<SuccessResponse<unknown>>(`${this.apiUrl}refresh`, {}).pipe(map((r) => r.data));
    }

    forgotPassword(data: ForgotPasswordRequest): Observable<unknown> {
        return this.http.post<SuccessResponse<unknown>>(`${this.apiUrl}forgot-password`, data).pipe(map((r) => r.data));
    }

    resetPassword(data: ResetPasswordRequest): Observable<unknown> {
        return this.http.post<SuccessResponse<unknown>>(`${this.apiUrl}reset-password`, data).pipe(map((r) => r.data));
    }

    changePassword(data: ChangePasswordRequest): Observable<unknown> {
        return this.http.post<SuccessResponse<unknown>>(`${this.apiUrl}change-password`, data).pipe(map((r) => r.data));
    }

    me(): Observable<UserProfile> {
        return this.http
            .get<SuccessResponse<UserProfile>>(`${this.configService.apiUrl}profile/me`)
            .pipe(map((r) => r.data));
    }
}
