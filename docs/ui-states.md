# UI states the client must handle

End-to-end encryption creates states an ordinary messenger UI has no concept of. Collapsing them
into "text" or "error" makes the interface **lie about the security guarantee** — which is worse
than showing nothing, because a user cannot tell a message they are not meant to read from one that
failed to arrive intact.

`MessageService.decrypt()` returns an explicit `DecryptStatus` for exactly this reason. Every value
below needs its own visual treatment.

## Message-level states

| Status | Meaning | Must NOT look like |
|---|---|---|
| `ok` | Decrypted and signature verified | — |
| `no_key` | We hold no grant for this sender's chain **yet** | An error. This is transient and normal — the sender simply has not wrapped their chain for us. It usually resolves on its own. |
| `unverified` | Decrypted, but the signature did not verify | Ordinary text. The content may be forged. |
| `failed` | Decryption failed outright | A blank message. Could be tampering, a consumed chain index, or a stale grant. |
| `plaintext` | Legacy unencrypted message, or a channel post | An encrypted message. The lock affordance must be absent. |
| `legacy` | Pre-migration RSA content | A loading state. It is **permanently** unreadable. |

Messages also carry `senderVerified`. Show the verified indicator only when a signature was
actually checked and passed — never as a default.

## Conversation-level states

- **History floor** — "Messages before you joined are unavailable." Permanent, not loading. The
  server withholds pre-join ciphertext entirely so it cannot leak sender, timing, size or reply
  structure.
- **Encryption boundary** — "Messages before this point were not encrypted." Group history from
  before encryption was enabled stays plaintext forever; it is never retroactively sealed.
- **Re-keying** — brief state after a member joins or leaves while the chat opens a new epoch.
- **Send blocked** — the server rejected a send with `409 EPOCH_STALE` because the chat re-keyed
  mid-compose. The client re-encrypts from plaintext and retries automatically; surface it only if
  the retry also fails.

## Security-critical states

These carry the most weight and should be the least like ordinary chrome.

**Safety number** — 12 groups of 5 digits, plus a QR code. Two users compare it out of band. This
is the **only** defence against the server substituting a public key, so it must be reachable in
one or two taps, not buried. It needs a distinct **key-changed** variant: when a peer's key
changes, the number changes, and the user must be told loudly rather than silently re-trusting.

**Roster verification failure** — the highest-severity state in the app. It should be
unmistakable, block key distribution and sending, and read as "the server may be lying to you."
The backend **cannot** enforce any of this; only the client can.

It has **two distinct causes**, and they are not interchangeable:

- *Binding signature invalid* — a roster entry's X25519 key is not vouched for by that device's own
  Ed25519 signing key, or a signed prekey arrives without a valid signature. This is the stronger
  signal: the signing key is what the peer pins out of band as a safety number, so a key that fails
  its binding is one nobody with the private half ever endorsed.
- *Member set hash mismatch* — the roster disagrees with the commitment stored on the epoch. Cheaper
  and more circumstantial, since the server writes both, but it catches a device inserted or dropped
  after the epoch opened.

Both must block. They are thrown as `RosterVerificationError` and classified by **type**, never by
message text — an earlier prefix match silently stopped recognising the binding failure when it was
added, so sending continued and no banner appeared for the failure that matters most.

The check runs in two places, and both must stay in step: `KeyStoreService.verifyRoster` before
wrapping, and `chat-info`, which recomputes independently on the screen that shows the roster.

**Removed from a chat, or the chat was deleted** — both arrive as `chat_deleted` on the socket,
because from this client's side the outcome is identical and there is nothing useful to
distinguish. The chat must disappear from the list, and the conversation pane must navigate away
rather than keep rendering against a chat that no longer exists. Nothing was sent at all before,
so a removed member's client went on showing a conversation they could no longer read or post to
until they happened to reload.

**Owner cannot leave** — an owner has no Leave action available, because a chat with no owner has
nobody who can ever delete it or hand it on. Say so *before* the press, alongside the two ways
out: transfer ownership, or delete the chat. A refusal after the fact tells the user nothing
about what to do instead.

**Destructive confirmations** — transferring ownership, deleting a chat, and revoking a device are
each irreversible and each need a deliberate second step. Deleting a chat in particular must say
"for everyone": in most messengers deleting a conversation removes only your own copy, so the
scope is the thing a user is most likely to misjudge. Revoking a device must not promise more than
it delivers — future messages become unreadable to it, but whatever it already received stays
readable, and no server can take that back.

**Channel badge** — channels are signed but **not** encrypted, deliberately (see
`docs/crypto-spec-v1.md` §6). If the UI shows the same lock as a private chat, it is claiming a
guarantee that does not exist.

## Flow states

- **Unlock** — after login the private bundle is decrypted with the user's password via Argon2id at
  64 MiB. That takes a noticeable moment on purpose; it is what protects the bundle if the database
  is ever disclosed. It needs a real progress state, not a flash of spinner.
- **Password reset** — destroys the identity irrecoverably. All prior history becomes permanently
  unreadable. The UI must say so plainly *before* the user proceeds, not after.
- Ordinary states still apply: empty chat list, loading, offline/reconnecting, message
  sending/sent/failed.
