# Returning customer personal area

The homepage always exposes “האזור האישי שלי”. Existing customer device sessions authenticate through GET /api/v2/me with x-customer-token. The UI displays the actual customer name/phone, upcoming booking groups, completed visit count, management links and booking entry with the existing profile prefill. Missing sessions show a truthful guest explanation and booking CTA. Temporary network/server errors retain the token and offer retry; only 401 removes it.

No server model or authentication change was made. Claude dependencies: verified phone sign-in/recovery (OTP request/verify, rate limits and session issuance), cross-device access, and visit history endpoint if full historical rows are desired. A phone number alone must never unlock the account. Existing booking confirmation links remain usable without an account session.

Validated locally with a real memory-server booking/session/management link and cleanup cancellation. Tested guest, returning session, retry, preserved profile and 320/390/768/1440 viewport widths. Production validation uses the guest entry only; no production test booking or messaging.
