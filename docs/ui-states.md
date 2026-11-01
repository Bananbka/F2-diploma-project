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

### Structured messages (polls, locations)

The sealed payload can also be a *poll*, a *location*, or something this version cannot interpret
(`docs/crypto-spec-v1.md` §4.7). These are properties of an **opened** message (`status: ok`); a
message that did not open keeps its `DecryptStatus` treatment above and never shows poll or
location content.

| Content | Must |
|---|---|
| Poll | Show the question, options, counts and percentages derived from the votes (never stored), the user's own choice, and a closed state ("Closed" / "time is up"). Voter names appear only in a public poll; an anonymous poll shows counts only and says, next to the "Anonymous" label: "Anonymous only in the interface: the server knows who voted, and other members' browsers can see it too. This app merely hides it." Votes loading, a failed load (with a Retry button), votes that could not be read ("N votes could not be read") and a truncated list ("Result may be incomplete") are shown as warnings, not footnotes. An edited poll says the author edited it and that earlier votes are not counted. |
| Poll, own vote | Not counted locally until the server accepted the control message; a failure is shown on the card. |
| Poll, closing | Offered only to the poll's author, with a confirmation. |
| Location | A card with rounded coordinates (full precision is kept), optional label and accuracy, and an "Open in map" link (new tab, `noopener noreferrer`). No map tiles, no request to a map provider until the user follows the link. Out-of-range coordinates show "Invalid location". |
| Unsupported | "Unsupported message" with the reason (unknown type, newer format, malformed contents, misplaced). **Not** shown as text, and not hidden. |
| Vote / close | Control messages are **never** a row in the conversation, a preview, an unread count, a forward, or a plain-message export entry. |

Entry points (poll, location) go through the same guard as the other composer triggers:
`unavailableReason()` covers an unverified member set, a read-only conversation, editing, and a
voice recording, and each submit re-checks it. They are absent in channels (signed posts cannot
carry a sealed payload). The UI offers no edit or forward for a poll or location (the server would still
accept an edit from a modified client; see `docs/tech-debt.md` section 11), and the selection bar
explains why the forward count can be lower than the selection.

The location dialog asks for the position only after an explicit button press, explains denied /
unavailable / timeout / unsupported outcomes, never retries on its own, and previews the
coordinates before anything is sent.

### Export

"Export chat history" (chat info) states that the file will contain **decrypted** content, shows
progress (indeterminate while the history length is unknown) and can be cancelled. The file lists a
message that could not be decrypted with its `DecryptStatus` instead of dropping it; contains no keys,
ciphertext or attachment URLs; and lists poll voters only for a public poll. A poll whose votes could not
all be fetched or read is marked `votes_complete: false` (with `votes_fetch_failed`, `votes_truncated`
and `votes_unreadable`) rather than written as if the counts were final, and the done state says how
many messages could not be read.

## Conversation-level states

- **History floor** — "Messages before you joined are unavailable." Permanent, not loading. The
  server withholds pre-join ciphertext entirely so it cannot leak sender, timing, size or reply
  structure.
- **Encryption boundary** — "Messages before this point were not encrypted." Group history from
  before encryption was enabled stays plaintext forever; it is never retroactively sealed.
- **Re-keying** — brief state after a member joins or leaves while the chat opens a new epoch.
- **Send blocked** — the server rejected a send with `409 EPOCH_STALE` because the chat re-keyed
  mid-compose. The client re-encrypts from plaintext and retries automatically; surface it only if
  the retry also fails. The retry happens exactly once, under the same `client_message_id`, sealed
  for `details.current_epoch`; if it fails too the message stays in the list as "Send failed" with
  Retry/Discard.
- **Key not shared** (`RETRY_LIMIT_EXCEEDED`) — publishing our sender key failed three times
  (network, 5xx, `EPOCH_CLOSED`, `GRANT_SET_MISMATCH`; waits of 250 ms then 500 ms, roster re-read and
  re-verified each time). Nothing is suspicious, so this is a plain retryable "Not sent" row with its
  own wording, never the roster alarm. An exhausted `EPOCH_CLOSED` is treated like `EPOCH_STALE` and
  re-sealed once for the current epoch first.
- **Read receipts** are per-participant, derived from `GET /chats/{id}/read-state` plus the
  `message_read` broadcast, and shown only on the current user's own sent messages. A private chat
  gets an ordinary single/double tick; a group gets a double tick once every other member has read
  up to that message, or a compact "N/M" count while some have not. `MessageDocument.is_read` — a
  single boolean per message — is not the source for any of this: one member reading a group
  message used to flip it for everyone, which is why this used to be sent-tick-only.

## Security-critical states

These carry the most weight and should be the least like ordinary chrome.

**Safety number** — 12 groups of 5 digits, plus a QR code. Two users compare it out of band. This
is the **only** defence against the server substituting a public key, so it must be reachable in
one or two taps, not buried. It needs a distinct **key-changed** variant: when a peer's key
changes, the number changes, and the user must be told loudly rather than silently re-trusting.
The number depends on both parties' keys, so confirmations are remembered per pair (own account,
peer): another account of the user's own on the same browser starts unverified instead of raising a
false key-changed alarm, and records from before this keying read as unverified, never as verified.

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

Both must block. They are thrown as `RosterVerificationError` (binding failure, code
`ROSTER_VERIFICATION_FAILED`) and its subclass `MemberSetMismatchError` (code `MEMBER_SET_MISMATCH`),
and the chat banner words each differently. They are never retried. Both are classified by **type**, never by
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

## Context menus

One overlay (`ContextMenuService` + `app-context-menu-host`) serves every custom menu; elements opt in with `[appContextMenu]` and an entries provider.

- **Triggers:** right-click; Menu key or Shift+F10 on the focused element (anchored to it, first item focused); touch press held 500 ms (cancelled by movement beyond 10 px or lifting early; the lifting finger cannot activate an item for 400 ms; the click that ends the press is swallowed).
- **Keyboard:** Up/Down/Home/End, type-ahead by first letter, Right opens a submenu and Left or Escape returns, Enter/Space activate (native button click), Tab or Escape close. Focus goes to the menu and returns to the trigger on action, Escape and Tab (not on an outside click, scroll or resize).
- **Closes on:** outside press, Escape, scroll anywhere, window resize, navigation, or another menu opening.
- **Semantics:** `menu` / `menuitem` / `menuitemcheckbox` (with `aria-checked`), `aria-haspopup`/`aria-expanded` on submenu parents, `aria-disabled` plus a `title` reason on disabled items. Destructive items are red and always followed by a confirmation dialog.
- **What keeps the native menu:** text fields, links and selected text inside a host; hosts whose provider returns no entries (emoji outside "Recently used"); anywhere without `appContextMenu`.
- **Menus that exist:** chat-list rows (pin, mute submenu, mark unread/read, add to folder, clear history, leave/delete as the server allows: never for private chats, Delete instead of Leave for an owner behind two confirmations), folder rows (edit chats, rename, delete), message bubbles (same builder as the overflow button; a sticker adds View Sticker Set), stickers in the picker and Recently used (View Sticker Set, Remove from Recent), emoji in Recently used, chat members (the same entries as the member profile, plus Message), and stickers in the pack manager.

## Chat list navigation and chat info

- **Chat list views** (`features/chat/chat-nav`): the pill row is gone. Two collapsible sections sit above the list: **Chats** (All chats, Direct, Groups, Channels, Unread) and **Folders** (the user's folders, each with a chat count and an unread badge). Each header is a disclosure button (`aria-expanded`) over a `listbox`; arrows/Home/End move inside a list, Enter/Space select. The collapsed state is remembered in localStorage. The Folders header has **+** (new folder) and **...** (new folder, fold the Chats section, show all chats). Selecting a view filters the list; the rail's Chats/Groups/Channels still pre-select the matching view. A folder row's menu offers Edit chats in folder, Rename and Delete (confirmed). Both Edit and Rename open the one **folder dialog** (name plus a searchable checklist of chats), saved as the complete chat list because the API replaces `chat_ids` wholesale. A failed save keeps the dialog open with its input.
- **Chat info** (panel Profile view and `/chats/:id/info`): a compact header (avatar, name, member count or @username, one verification badge) over tabs. Group/channel: Members (Subscribers) | Settings | Data. Private: Profile | Settings | Data. Members lists, adds and opens members; Settings holds mute and invite links (admins and owners); Data holds export, clear history, and leave/delete. The selected tab is kept for the session. Leave, delete and clear history explain themselves in a confirmation dialog rather than in standing help text; the one standing note is why an owner cannot leave. The member-set alarm stays above the tabs on every tab.
- **Member profile:** clicking or pressing Enter on a member row replaces the tabs with that member's profile and a Back button (Escape also goes back). It shows avatar, name, @username, role, the identity-key status (published is a fact about the roster, not a verification), and offers Safety number, Message (opens or creates the private chat), Save as contact, and, only where the server's rank rules allow, change role, Make owner and Remove (both confirmed). There is no bio: the public user projection the client can read does not carry one.
- **Group avatars:** a group or channel without a picture uses the same coloured monogram circle as a person, coloured from the chat id (so a rename keeps the colour), with the first letter of up to two words of the title. A leading `#`, punctuation and emoji are skipped; a title that is only an emoji shows the emoji; only a title with nothing displayable falls back to the Users (or Hash for a channel) icon. Sizes are the avatar's own, so list row, header, panel, forward picker and invite preview agree.

## Settings dialog and avatar cropper

Settings is a dialog (`SettingsService` + `app-settings-modal`, mounted in the app root), not a page. Tabs: **Profile** (name, username, bio, avatar; email and phone read-only), **Security** (change password, devices and revoke, prekey rotation, pointer to safety numbers), **Stickers** (the pack manager), **Privacy & data** (what is and is not private, account deletion). There is no About tab; nothing worth showing exists yet.

- **Opening:** the rail's Settings button, or the account menu's Edit profile / Change password. `/settings/profile`, `/settings/password`, `/settings/security|stickers|privacy` and `/stickers/manage` still work: followed from inside the chat shell they cancel the navigation and open the dialog over the current conversation; from a cold load or any other page they redirect to `/chats` and open it there. The guard sits under `authGuard`, so a signed-out visitor never sees the dialog.
- **Keyboard and focus:** `role="dialog"`, `aria-modal`, Tab trapped (a nested cropper or deletion dialog owns focus while open), Escape closes only the topmost layer, focus returns to the button that opened it. The tablist uses manual activation: arrows/Home/End move focus, Enter or Space selects. Vertical on wide screens, horizontal and scrollable on narrow ones, where the dialog is full-screen.
- **Unsaved changes:** closing the dialog or leaving the Profile tab with edited fields or a not-yet-saved new avatar asks "Discard changes?". Everything else saves immediately, so nothing else guards.
- **Avatar cropper** (`shared/ui/avatar-cropper`, reusable): choosing a photo opens a circular crop frame. Drag or arrow keys (Shift for larger steps) pan; wheel, pinch, the slider or +/- zoom (1x to 8x); rotate a quarter turn either way; reset (also `0`). The picture always covers the frame. EXIF orientation is applied, images over 4096px are downscaled on decode, and the result is a 512x512 WebP (PNG where WebP cannot be encoded) uploaded through the normal avatar upload. As before, the new avatar only becomes the profile's once Save is pressed.
- **Cropper failures:** a non-image, an empty or over-30 MB file, and an undecodable image each show their own message in the dialog, with Apply disabled. The picture is drawn on a canvas from an `ImageBitmap`, so no object URL exists to leak; the bitmap is closed on cancel, apply, error and destroy.
