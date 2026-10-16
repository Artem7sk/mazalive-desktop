# MAZLIVE Desktop Privacy Policy

**Software:** MAZLIVE Desktop ("MAZLIVE Desktop 2.0")
**Project:** MAZLIVE
**Author (controller):** MAZA PRODUCTION
**Document version:** draft-1 (2.0.0-beta.24)

> **Status:** PREPARED FOR LEGAL REVIEW; not reviewed by a lawyer.
> Unknown technical details are marked as `[to be provided]`.

---

## 1. General

1.1. This Policy describes what data the MAZLIVE Desktop application processes, for
     what purposes, to whom it is transferred, and how Users can exercise their rights.

1.2. MAZLIVE Desktop is a **client application** that works with the MAZLIVE service.
     Some data is transferred to MAZLIVE servers (`https://mazlive.com` and
     `https://games.mazlive.com`). Please note: **not all data is stored locally
     only** — authentication data, stream events and service requests are sent to
     the service's servers.

1.3. Data controller: the author of the MAZLIVE project — MAZA PRODUCTION.

---

## 2. Data We Process

### 2.1. Credentials and account data
- **Session authentication token** (cookie `authjs.session-token`): obtained at login
  via the MAZLIVE dashboard; used for API requests and subscription checks.
- **Profile data** received from the server (`/api/auth/verify-subscription`):
  user identifier (`userId`), name (`name`), e-mail (`email`), profile image (`image`).
- **TikTok username** (cookie `tiktok_username`): used as the stream room identifier.

### 2.2. Stream data (TikTok events)
Only during an active broadcast, the app receives stream events from the server via
Socket.IO (`games.mazlive.com`, namespace `/viewer`):
- gift, like, follow and viewer-join events;
- **viewer avatars** (for in-game display);
- nicknames/identifiers of viewers participating in events.
This data is provided by the MAZLIVE server and used for game mechanics ("King of the Hill").

### 2.3. Room token
- A temporary game-room access token (JWT, ~15 minutes) is received via API requests
  and stored **in process memory only**.
- The token is **not saved to disk** and is refreshed on a timer (~every 12 minutes).

### 2.4. Data stored locally
The app stores locally (via `electron-store`):
- **session token** and profile data — in the `mazalive-auth` file (encrypted);
- **GTA game settings** (reaction rules, course parameters) — in the `mazalive-gta` file;
- **session cookies** in the app's session storage.
This data stays on the User's device and is not synced as a separate store, except
when the MAZLIVE service is accessed.

### 2.5. Service data
- **Diagnostic logs** (console logs) — produced locally for diagnostics; generally not
  automatically transmitted to the server.
- **Update checks** — periodic requests to `mazlive.com` for update metadata (`beta.yml`).

### 2.6. Data we do NOT collect
- The app does not request access to contacts, camera, microphone, or location.
- The app does not collect payment data — payment happens on the website side.
- The app does not embed DRM, telemetry, or remote-control mechanisms.

---

## 3. Purposes of Processing

- User authentication and session maintenance.
- Subscription verification and granting access to games.
- Receiving and processing stream events for game mechanics.
- Persisting user settings across launches.
- Delivering application updates.
- Diagnostics and maintaining operational health (local logs).

---

## 4. Data Transfer and Recipients

Data is transferred to the following recipients:
- **MAZLIVE servers** (`mazlive.com`, `games.mazlive.com`) — to operate the service,
  authentication, subscription, and stream events.
- **Third-party platforms (TikTok, etc.)** — to the extent needed to receive stream
  events via the relevant services (transfer is performed by the MAZLIVE server, not
  directly by the app).
- **Update service** — requests for update metadata.

The app does not sell personal data to third parties.

---

## 5. Retention Periods

- **Session token** — stored locally and considered valid for up to 30 days (re-login
  required afterwards); removed on logout.
- **Room token** — memory only, up to ~15 minutes / until the app closes.
- **Game settings** — until the User deletes them or uninstalls the app.
- **Retention on the MAZLIVE server side** — `[to be provided]` (defined by the
  service's policy).

---

## 6. User Rights and How to Contact Us

The User may:
- request access to, correction of, or deletion of their data;
- log out, which clears local session data and cookies (the app performs a full storage
  cleanup on logout);
- uninstall the app and delete associated local files.

To exercise your rights, contact the author of the MAZLIVE project (MAZA PRODUCTION).

---

## 7. Security

- The session is stored with encryption (electron-store).
- The room token is never written to disk.
- Context isolation is enabled (`contextIsolation: true`, `nodeIntegration: false`).
- External links open only in the system browser; in-app navigation is restricted to
  trusted domains.

---

## 8. Items to Confirm (unknown data)

The following technical/legal details are to be clarified before publishing a final
version. The author of the project (MAZA PRODUCTION) did not provide them; they are
intentionally not invented:
1. Exact retention periods on the MAZLIVE server side.
2. List of sub-processors (hosting, TikTok integration, analytics) and their roles.
3. Applicable law and supervisory authority.
4. Presence/absence of cross-border data transfers.
5. Legal basis for processing (consent, contract, legitimate interest).

---

> © MAZA PRODUCTION. Prepared for legal review; not legal advice.
