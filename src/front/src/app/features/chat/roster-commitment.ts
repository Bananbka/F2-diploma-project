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
