import { computeMemberSetHash } from '../../core/crypto/grants';
import { generateIdentity } from '../../core/crypto/identity';
import { b64uEncode } from '../../core/crypto/primitives';
import { ChatRoster, RosterEntry } from '../../core/models/crypto.model';
import { rosterMatchesCommitment, rosterMatchesMembers, rosterWithinMembers } from './roster-commitment';

const CHAT = 'c0000000-0000-4000-8000-000000000001';
const ALICE = 'a0000000-0000-4000-8000-000000000001';
const BOB = 'b0000000-0000-4000-8000-000000000002';
const MALLORY = 'e0000000-0000-4000-8000-000000000003';

let deviceCounter = 0;

/** A roster entry whose identity key really is vouched for by its own signing key. */
function entry(userId: string, overrides: Partial<RosterEntry> = {}): RosterEntry {
    deviceCounter += 1;
    const deviceId = `d0000000-0000-4000-8000-${String(deviceCounter).padStart(12, '0')}`;
    const bundle = generateIdentity(userId, deviceId, false);
    return {
        user_id: userId,
        device_id: deviceId,
        identity_key_id: deviceId,
        identity_public_key: b64uEncode(bundle.identityPublic),
        signing_public_key: b64uEncode(bundle.signingPublic),
        identity_key_signature: b64uEncode(bundle.identityKeySignature),
        signed_prekey_public: null,
        signed_prekey_signature: null,
        ...overrides,
    };
}

/** Self-consistent: the commitment is the hash of exactly these members, as a lying server can arrange. */
function roster(...members: RosterEntry[]): ChatRoster {
    return { chat_id: CHAT, current_epoch: 1, member_set_hash: computeMemberSetHash(members), members };
}

describe('roster commitment checks', () => {
    describe('rosterWithinMembers', () => {
        it('accepts a roster whose every entry belongs to a listed member', () => {
            expect(rosterWithinMembers(roster(entry(ALICE), entry(ALICE), entry(BOB)), [ALICE, BOB])).toBeTrue();
        });

        it('accepts a member with no device in the roster yet', () => {
            expect(rosterWithinMembers(roster(entry(ALICE)), [ALICE, BOB])).toBeTrue();
        });

        it('refuses a device under a user id the member list does not contain', () => {
            expect(rosterWithinMembers(roster(entry(ALICE), entry(MALLORY)), [ALICE, BOB])).toBeFalse();
        });

        it('skips inactive entries: nothing is wrapped to them', () => {
            expect(rosterWithinMembers(roster(entry(ALICE), entry(MALLORY, { is_active: false })), [ALICE])).toBeTrue();
        });

        it('refuses any active entry when the member list is empty', () => {
            expect(rosterWithinMembers(roster(entry(ALICE)), [])).toBeFalse();
        });
    });

    describe('rosterMatchesMembers', () => {
        it('needs both: the commitment check alone passes a roster with an outsider in it', () => {
            const planted = roster(entry(ALICE), entry(BOB), entry(MALLORY));

            expect(rosterMatchesCommitment(planted)).withContext('self-consistent').toBeTrue();
            expect(rosterMatchesMembers(planted, [ALICE, BOB])).toBeFalse();
        });

        it('passes a verified roster of listed members only', () => {
            expect(rosterMatchesMembers(roster(entry(ALICE), entry(BOB)), [ALICE, BOB])).toBeTrue();
        });

        it('still fails on the commitment when everyone is a listed member', () => {
            const forged = { ...roster(entry(ALICE), entry(BOB)), member_set_hash: 'forged' };

            expect(rosterMatchesMembers(forged, [ALICE, BOB])).toBeFalse();
        });
    });
});
