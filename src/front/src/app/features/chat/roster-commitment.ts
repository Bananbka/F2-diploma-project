import { computeMemberSetHash } from '../../core/crypto/grants';
import { verifyIdentityBinding, verifySignedPrekey } from '../../core/crypto/identity';
import { b64uDecode } from '../../core/crypto/primitives';
import { ChatRoster } from '../../core/models/crypto.model';

/**
 * The anti-ghost check, as a screen runs it on the roster it just fetched — the same pair
 * `KeyStoreService.verifyRoster` enforces before wrapping. Every screen that claims "the member list
 * matches the commitment" must have run exactly this on the roster it shows, never infer the claim
 * from the absence of a send-path alarm.
 *
 * Two independent things, both required:
 *
 * **The binding signatures.** Each entry's X25519 key must be vouched for by that device's own
 * Ed25519 signing key — the key a peer pins out of band as a safety number. This is the actual root
 * of trust; without it the roster is merely what the server says it is.
 *
 * **The member set hash**, recomputed from the whole roster entry and compared against the epoch's
 * stored commitment. Over `roster.members`, not the device ids alone: the commitment binds the key
 * material, precisely because hashing ids alone let a server keep the device set identical and swap
 * one member's public key for its own.
 */
export function rosterMatchesCommitment(roster: ChatRoster): boolean {
    const bindingsValid = roster.members.every((member) => {
        const signingPublic = b64uDecode(member.signing_public_key);

        const identityBound = verifyIdentityBinding(
            member.user_id,
            member.device_id,
            b64uDecode(member.identity_public_key),
            signingPublic,
            b64uDecode(member.identity_key_signature)
        );

        if (!identityBound) {
            return false;
        }

        if (!member.signed_prekey_public) {
            return true;
        }

        return (
            !!member.signed_prekey_signature &&
            verifySignedPrekey(
                member.user_id,
                member.device_id,
                b64uDecode(member.signed_prekey_public),
                signingPublic,
                b64uDecode(member.signed_prekey_signature)
            )
        );
    });

    return bindingsValid && computeMemberSetHash(roster.members) === roster.member_set_hash;
}

/**
 * True when every active roster entry belongs to someone in `participantIds`.
 *
 * `rosterMatchesCommitment` proves the roster is self-consistent; it says nothing about *who* is in
 * it. The members a screen lists come from the chat's participant list, a different server answer,
 * so a roster carrying a device under a user id the chat does not name is consistent with its own
 * commitment and invisible in the list. Inactive entries are skipped, as everywhere: nothing is
 * wrapped to them. The send path makes the same comparison in `KeyStoreService.verifyRosterMembership`.
 */
export function rosterWithinMembers(roster: ChatRoster, participantIds: Iterable<string>): boolean {
    const allowed = new Set(participantIds);
    return roster.members.every((member) => member.is_active === false || allowed.has(member.user_id));
}

/**
 * What a screen must have checked before saying "the member list matches the commitment": the roster
 * verifies against the commitment, *and* it names nobody outside the member list being shown.
 */
export function rosterMatchesMembers(roster: ChatRoster, participantIds: Iterable<string>): boolean {
    return rosterMatchesCommitment(roster) && rosterWithinMembers(roster, participantIds);
}
