import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { SuccessResponse } from '../models/api.model';
import {
    ChatKeys,
    ChatRoster,
    IdentityPublishRequest,
    KeyEpoch,
    OwnIdentity,
    PrekeyRotateRequest,
    PublicKey,
    SenderKeyUpload,
} from '../models/crypto.model';
import { ConfigService } from './config.service';

@Injectable({ providedIn: 'root' })
export class CryptoApiService {
    private readonly http = inject(HttpClient);
    private readonly configService = inject(ConfigService);

    private get apiUrl(): string {
        return this.configService.apiUrl + 'crypto/';
    }

    publishIdentity(data: IdentityPublishRequest): Observable<PublicKey> {
        return this.http.post<SuccessResponse<PublicKey>>(`${this.apiUrl}identity`, data).pipe(map((r) => r.data));
    }

    /** Own key material, including the wrapped private bundle needed to unlock after login. */
    getOwnIdentities(): Observable<OwnIdentity[]> {
        return this.http.get<SuccessResponse<OwnIdentity[]>>(`${this.apiUrl}identity/me`).pipe(map((r) => r.data));
    }

    /** Revoke one of this account's own devices, and re-key its encrypted chats. */
    revokeDevice(deviceId: string): Observable<{ message: string }> {
        return this.http
            .post<SuccessResponse<{ message: string }>>(`${this.apiUrl}identity/${deviceId}/revoke`, {})
            .pipe(map((r) => r.data));
    }

    /**
     * Rotate this device's medium-term signed prekey.
     *
     * Does not touch the identity keypair, its version, or any existing grant — see
     * `KeyStoreService.rotatePrekey` and crypto-spec-v1.md §2.1.2. The request carries the client's
     * entire re-sealed private bundle alongside the new public prekey and its signature, so the
     * server can write both in one transaction.
     */
    rotatePrekey(data: PrekeyRotateRequest): Observable<PublicKey> {
        return this.http
            .put<SuccessResponse<PublicKey>>(`${this.apiUrl}identity/prekey`, data)
            .pipe(map((r) => r.data));
    }

    getKeysBatch(userIds: string[]): Observable<PublicKey[]> {
        return this.http
            .post<SuccessResponse<PublicKey[]>>(`${this.apiUrl}keys/batch`, { user_ids: userIds })
            .pipe(map((r) => r.data));
    }

    getSafetyNumber(peerUserId: string): Observable<string> {
        return this.http
            .get<SuccessResponse<{ safety_number: string }>>(`${this.apiUrl}safety-number/${peerUserId}`)
            .pipe(map((r) => r.data.safety_number));
    }

    enableEncryption(chatId: string): Observable<KeyEpoch> {
        return this.http
            .post<SuccessResponse<KeyEpoch>>(`${this.apiUrl}chats/${chatId}/enable`, {})
            .pipe(map((r) => r.data));
    }

    /** Member devices and their keys, plus the epoch's member_set_hash for client verification. */
    getRoster(chatId: string): Observable<ChatRoster> {
        return this.http
            .get<SuccessResponse<ChatRoster>>(`${this.apiUrl}chats/${chatId}/roster`)
            .pipe(map((r) => r.data));
    }

    getChatKeys(chatId: string, sinceEpoch = 0): Observable<ChatKeys> {
        return this.http
            .get<SuccessResponse<ChatKeys>>(`${this.apiUrl}chats/${chatId}/keys`, {
                params: new HttpParams().set('since_epoch', sinceEpoch),
            })
            .pipe(map((r) => r.data));
    }

    publishSenderKey(chatId: string, epoch: number, data: SenderKeyUpload): Observable<unknown> {
        return this.http
            .post<SuccessResponse<unknown>>(`${this.apiUrl}chats/${chatId}/epochs/${epoch}/sender-keys`, data)
            .pipe(map((r) => r.data));
    }
}
