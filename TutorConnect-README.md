# TutorConnect

## Local HTTPS

The Docker gateway serves the app over HTTPS by default:

```bash
./start-local.sh
```

The startup script creates a local self-signed certificate in `nginx/certs/` when one is not already present. The default browser entrypoint is `https://localhost:8443`; if your existing `.env` keeps `NGINX_HOST_PORT=8080`, use `https://localhost:8080`.

## Stripe payment and tutor payout flow

The Stripe keys in the root `.env` belong to the TutorConnect platform environment. Learners who set up payments are represented as Stripe Customers and can save payment methods, while tutors who begin payout onboarding receive Stripe Express connected accounts. For a paid booking, TutorConnect charges the learner's saved payment method when the booking is accepted, either by the tutor or when the learner accepts a tutor-proposed time. The tutor's connected account must be payout-ready before a paid booking can be accepted.

After a lesson's scheduled end, the tutor can mark it complete. The learner then has 48 hours to confirm completion early or report that the lesson was not completed. If the learner takes no action, the application closes the review automatically when the window expires and makes the tutor earning eligible for payout. Once a lesson has started, the tutor can instead record that it was not completed; for a paid lesson, this starts a full refund to the original payment method. Administrators and system administrators can resolve disputed completion claims by approving the tutor earning or refunding the learner. They can review these outcomes and eligible earnings from `/admin/payouts`, process one selected tutor, or process all tutors whose earnings and payout accounts are ready.

Within each payout run, the backend creates one combined Stripe Transfer per tutor and currency. It records the Stripe transfer ID and a lesson-level audit item for every included earning. `payment.status = PAID` means that the learner's charge succeeded. `payment.payoutStatus = PAID` means that the related tutor earning was transferred to the tutor's connected Stripe balance; Stripe handles the later payout from that balance to the tutor's bank account.

The database seed creates demo users, tutors and subjects, together with accepted and pending bookings for scheduling, completion, dispute and refund demonstrations. Accepted paid fixtures use database-only payment records with `payment.status = PAID` and `payment.payoutStatus = PENDING`; the pending booking fixture has `payment.status = PENDING`. Re-running the seed against the same database preserves existing payment states, including transferred fixtures, rather than making the same lesson eligible twice:

```bash
docker compose exec backend pnpm db:seed
```

Seeded payments do not add funds to Stripe or create connected accounts. An earning remains pending until its completion review is cleared and can remain blocked if the tutor's Stripe Connect account is not ready.

Use matching Stripe test-mode or sandbox publishable and secret keys locally. Forward provider events to the raw webhook endpoint and copy the signing secret printed by the listener into `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to http://localhost:5050/api/v1/payments/stripe/webhook
```

Restart the backend after updating `.env`. If `BACKEND_HOST_PORT` is customised, use that port instead. An indeterminate Stripe transfer response remains in `PROCESSING` and is retried with the same idempotency key on the next administrator payout action, reducing the risk of a duplicate transfer.

## Testing Strategy

TutorConnect uses automated Vitest suites for frontend and backend code developed in this project. The suite is split into unit, component, and API integration tests so business rules can be tested in isolation while the main API flows are still exercised through Express routes.

### Running Tests

Install dependencies from the repository root if needed:

```bash
corepack pnpm install --frozen-lockfile
```

Run backend tests from the repository root:

```bash
corepack pnpm --filter tutorconnect-backend test
```

Run frontend tests from the repository root:

```bash
corepack pnpm --filter tutorconnect-frontend test
```

Run every automated test from the repository root:

```bash
corepack pnpm test
```

Generate coverage reports:

```bash
corepack pnpm test:coverage
```

GitHub Actions runs the frontend test suite, frontend build, and backend test suite on pushes to `main`/`Arc` and pull requests targeting `main`.

Latest local verification on 11 August 2026:

- Backend: 28 test files and 527 tests passing, comprising 319 unit tests and 208 API integration tests.
- Frontend: 29 test files and 184 tests passing, comprising 133 helper/unit tests, 26 component tests and 25 page-level tests.
- Overall: 711 tests passing across 57 test files, with no failed or skipped tests.
- Backend coverage: 81.42% statements/lines, 77.21% branches and 87.71% functions across the configured backend source scope.
- Frontend coverage: 91.41% statements/lines, 80.17% branches and 81.55% functions across the 11 files selected by the frontend coverage configuration. These percentages do not represent the entire frontend.

### Backend Coverage

Backend tests live in `backend/tests`.

Current backend unit and API integration coverage includes:

- Identity and API access:
  - Registration, login, token refresh and role-based authorisation.
  - Authentication middleware, controller validation, socket authentication and health endpoints.
- Scheduling:
  - Time-zone conversion and daylight-saving transitions.
  - Availability slots, duration rules and cancellation policies.
- Booking lifecycle:
  - Trial lessons, recurring bookings and time-slot conflict prevention.
  - Price and time proposals, rescheduling, cancellation, completion review and disputes.
- Payments and payouts:
  - Payment-method setup, charge-on-acceptance, failed-payment recovery and refunds.
  - Stripe Connect onboarding, payout readiness, earnings, serialisation and administrator-initiated payouts.
- Communication and administration:
  - Learner/tutor conversations, support messaging, protected attachments and notifications.
  - Subject requests, reviews, tutor functions and administrator functions.

The backend suite covers both happy and sad cases, including successful workflows, validation failures, unauthorised access, stale state, duplicate requests, unavailable providers and retry/recovery behaviour.

The backend tests use `supertest` against the Express app and mock external or cross-layer dependencies with Vitest stubs. Prisma database access, email delivery, notification delivery, socket emission and Stripe configuration are mocked so that the tests can check our API behaviour without relying on a live database, email provider, socket server or payment provider.

### Frontend Coverage

Frontend tests live under `frontend/src/lib/__tests__`, `frontend/src/components/__tests__` and selected application-page `__tests__` directories. Current frontend coverage includes:

- Registration and discovery:
  - Registration validation and role-specific form rules.
  - Tutor search filters, location selection and invalid-input fallbacks.
- Scheduling:
  - Time-zone conversion, daylight-saving transitions and tutor availability.
  - Recurring-booking and trial-lesson behaviour.
- Booking and payment states:
  - Booking acceptance, price offers, pending-booking rescheduling and cancellation summaries.
  - Payment display and failed-payment recovery.
- Tutor and administrator workflows:
  - Earnings, payout onboarding and payout status.
  - Administrator navigation, payout pages and subject-request pages.
- User-interface behaviour:
  - Shared component interactions, support-chat badges and chat-attachment helpers.
  - Selected application-layout, logout and administration-page behaviour.

These tests cover rendering logic, component behaviour, user interactions, and deterministic form/business logic that supports the React UI. Component tests run in `jsdom` with Testing Library.

### Mocking and Stubbing

The automated suites mock external dependencies where direct integration would make the tests slow, fragile, or dependent on third-party state:

- Prisma is mocked in backend API integration tests to control database success and failure cases.
- Stripe is mocked or configured as unavailable to test payment fallback and error handling without calling the Stripe API.
- Email and notification services are stubbed to verify that the application requests the right side effects.
- Socket services are stubbed to verify emitted events without needing a running Socket.IO server.

### Manual End-to-End Coverage

The automated suite does not call real Stripe APIs or a production-like database in CI. The following scenarios cover the main browser-based workflows using the seeded local application and Stripe test-mode credentials where required.

Manual verification was completed on 11 August 2026 using the local Docker Compose deployment and Google Chrome. All listed scenarios passed.

| Flow | Setup | Steps | Expected result |
| --- | --- | --- | --- |
| Learner registration and verification fallback | Start the application locally with the default `.env.example` values. | Register a learner, inspect the verification response or email, then attempt login before and after verification. | Unverified login is blocked; verified login reaches the learner dashboard. |
| Tutor search and booking request | Use seeded learner and active tutor data. | Search by subject and location, open a tutor profile, choose an available time and submit a booking. | The booking is created with `PENDING` status and the tutor receives a notification. |
| Booking conflict handling | Use an already-booked tutor time slot. | Attempt to book an overlapping slot. | The application rejects the request and does not create a duplicate booking. |
| Trial and recurring bookings | Use a tutor with a trial limit and recurring availability. | Submit a free-trial request and create a recurring booking request. | The trial has a zero total with no payment, and recurring occurrences follow the selected schedule. |
| Price, time and rescheduling proposals | Log in as the learner and tutor for pending and accepted bookings. | Submit and resolve price/time proposals, then propose and accept a reschedule. | Both users see the accepted price or time, and stale or conflicting changes are rejected. |
| Cancellation policy | Use accepted bookings before and within the tutor's cancellation cutoff. | Cancel as the learner and tutor under the applicable policy conditions. | The recorded outcome and any refund match the cancellation policy captured on the booking. |
| Messaging, attachments and notifications | Log in as two seeded users in separate browsers. | Start a direct or support conversation, send a message and allowed attachment, then mark notifications as read. | Participants can access the message and attachment, while unread counts and notifications update. |
| Payment fallback | Run without Stripe secrets. | Open payment-method setup and booking-payment screens. | The UI and API show that payment setup is unavailable without crashing. |
| Stripe test-mode payment and recovery | Add matching Stripe test-mode keys and use Stripe test cards. | Save a payment method, accept a paid booking, exercise a failed charge and retry with a valid method. | Successful charges accept the booking; failed charges remain recoverable without creating a duplicate payment. |
| Completion review, dispute and refund | Use two accepted paid bookings whose scheduled end has passed. | Mark both lessons complete as the tutor; confirm one as the learner, then dispute and resolve the other as an administrator. | Confirmation makes the first earning eligible, while the dispute pauses the second payout until it is cleared or refunded. |
| Stripe Connect onboarding and tutor payout | Add matching Stripe test-mode keys and a webhook secret, then complete tutor Connect onboarding. | Make an earning eligible and process the selected tutor or all ready tutors from `/admin/payouts`. | Each tutor/currency group produces one transfer with a Stripe transfer ID and lesson-level audit items. |
| Subject requests | Log in as a learner and an active tutor. | Create a subject request as the learner, then view and accept it as the tutor. | The request status and participant notifications update for both users. |
| Administrator and tutor review | Use seeded administrator and tutor accounts. | Review tutor verification and profile information, then update the tutor's status. | The tutor status change is reflected in the administrator and tutor views. |

### Known Gaps

The current automated suite does not include full browser-based end-to-end tests. The manual scenarios above cover the core user workflows; a future Playwright suite with a seeded test database and Stripe test-mode credentials would make these checks repeatable in CI.

Frontend automated tests cover business helpers, shared components and selected application pages, including payout, subject-request and layout workflows. However, the reported frontend coverage percentages apply only to the 11 explicitly configured files rather than the complete frontend. Additional page-level tests for login and registration, tutor search, booking details and learner payment screens would strengthen this coverage.

Backend API integration tests exercise Express routes, middleware and controllers, but mock Prisma and external providers. They therefore do not verify real PostgreSQL transactions, advisory-lock behaviour or live Stripe contracts. Targeted real-database integration tests would provide stronger evidence for concurrency-sensitive booking and payout behaviour.
