import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ConfigService } from './config.service';
import { ProfileApiService } from './profile-api.service';

describe('ProfileApiService.deleteAccount', () => {
    let service: ProfileApiService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                { provide: ConfigService, useValue: { apiUrl: 'http://api.test/' } },
            ],
        });

        service = TestBed.inject(ProfileApiService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    /** `HttpClient.delete` cannot carry a body; the password has to travel in one. */
    it('sends DELETE /profile with the password in a JSON body', () => {
        let done = false;
        service.deleteAccount('hunter2hunter2').subscribe(() => (done = true));

        const req = http.expectOne('http://api.test/profile');
        expect(req.request.method).toBe('DELETE');
        expect(req.request.body).toEqual({ password: 'hunter2hunter2' });
        req.flush({ status: 'success', data: { message: 'Account deleted.' } });

        expect(done).toBeTrue();
    });

    it('never sends an Authorization header (auth is by httpOnly cookie)', () => {
        service.deleteAccount('pw').subscribe();

        const req = http.expectOne('http://api.test/profile');
        expect(req.request.headers.has('Authorization')).toBeFalse();
        req.flush({ status: 'success', data: {} });
    });

    it('surfaces 401 INVALID_PASSWORD and 429 to the caller', () => {
        const statuses: number[] = [];
        service.deleteAccount('wrong').subscribe({ error: (e: HttpErrorResponse) => statuses.push(e.status) });
        http.expectOne('http://api.test/profile').flush(
            { status: 'error', error_code: 'INVALID_PASSWORD', message: 'Invalid password.' },
            { status: 401, statusText: 'Unauthorized' }
        );

        service.deleteAccount('wrong').subscribe({ error: (e: HttpErrorResponse) => statuses.push(e.status) });
        http.expectOne('http://api.test/profile').flush(
            { status: 'error', error_code: 'RATE_LIMITED', message: 'Slow down.' },
            { status: 429, statusText: 'Too Many Requests' }
        );

        expect(statuses).toEqual([401, 429]);
    });
});
