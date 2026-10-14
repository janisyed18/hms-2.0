# Production Security Controls

## Application boundary

- Authentication uses Argon2 password hashing, short-lived bearer tokens, rotating `HttpOnly`, `Secure`, `SameSite=Strict` refresh cookies, and origin checks for cookie-bearing refresh and logout requests.
- Login attempts are limited per account and source IP: five attempts per five minutes, followed by a progressive lockout. Password-reset requests are limited to three per 15 minutes.
- Every `/api/` request is limited per client IP to 300 requests per minute. Redis is the authoritative counter. A deployed API returns `503` rather than serving unprotected traffic if this dependency is unavailable.
- Requests larger than 5 MiB are rejected before route processing. File uploads must remain disabled until they have a dedicated endpoint that validates type, size, content, storage key, malware scanning, and authorization.
- Pydantic API models reject unknown fields, preventing mass assignment. SQLAlchemy ORM bindings are used for application queries; direct SQL is limited to the fixed health-check query.
- Access checks resolve customer-scoped records before reads and mutations, so guessed identifiers do not bypass authorization. Public certificate verification uses an unguessable token-scoped route only.
- Object storage keys are normalized under an application-owned prefix. No user-controlled filesystem path is used for persisted files.
- The React clients render data through React, not raw HTML injection. Do not introduce `dangerouslySetInnerHTML`, `eval`, dynamic imports from user input, or server-side URL fetching without a reviewed allowlist.

## Browser and HTTP protections

- API responses set `Content-Security-Policy`, `Strict-Transport-Security` in deployed environments, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and `X-Frame-Options: DENY`.
- CloudFront applies the equivalent headers to static applications. The CSP includes `frame-ancestors 'none'`; `X-Frame-Options` is retained for legacy clients.
- Static and API CSP permits inline styles only because the existing frontend requires them. Inline scripts are not allowed. Remove `unsafe-inline` from `style-src` after migrating inline styles to hashed or external stylesheets.
- CloudFront sends a random origin header to the ALB API origin. ECS receives the same secret from Secrets Manager and refuses non-health requests without it. `SECURITY_EDGE_SHARED_SECRET` is a deployment invariant outside local/test.
- CloudFront is TLS-only for viewers. The current development ALB origin is HTTP because it has no custom DNS name or ACM certificate. The Terraform domain inputs atomically enable an ALB HTTPS listener, HTTP-to-HTTPS redirect, CloudFront `https-only` origin policy, and Route 53 aliases only when every required value is supplied.
- Configure `public_root_domain`, `staff_hostname`, `api_origin_hostname`, `public_hosted_zone_id`, `alb_acm_certificate_arn`, and `cloudfront_acm_certificate_arn` together. The ALB certificate must be issued in `ap-southeast-2` for `api_origin_hostname`; the CloudFront certificate must be issued in `us-east-1` for `staff_hostname`. Terraform creates no ACM certificates, so request and DNS-validate them manually before setting the ARNs.
- `staff_hostname` aliases to CloudFront and is the only public application/API base URL. `api_origin_hostname` aliases to the ALB solely so CloudFront can validate the ALB certificate. Direct API-origin traffic lacks the CloudFront secret and is rejected, except for narrowly scoped health endpoints.

## AWS traffic protection

- CloudFront provides TLS termination, caching, and edge absorption for static traffic.
- `enable_waf` is an explicit Terraform switch. When enabled, the ALB receives AWS WAF Common Rule Set protection and a 2,000-request-per-IP rolling five-minute rate rule. WAF has a monthly cost and is intentionally disabled in low-cost development until approved.
- WAF protects against common malicious traffic and high-volume abuse. It does not replace application authorization, scoped database access, CSRF controls, validation, or rate limits.
- AWS Shield Standard is included with AWS services. Use CloudWatch alarms and WAF sampled requests to investigate bot or DDoS events; do not rely on access logs for secrets.

## Supply chain and operations

- GitHub Actions are pinned to immutable commit SHAs. Dependabot opens weekly updates for actions, Python, and npm dependencies; updates require CI review before merge.
- Backend containers install from `uv.lock` with `--locked` and both backend and certificate images run as non-root users.
- `npm audit --omit=dev` is clean for both web applications. Run `uv lock --check`, Python test/lint/type checks, Terraform validation, and container builds in CI before deployment.
- Generic provider webhook secrets fail closed outside local/test, use constant-time comparison, and are accepted only in a request header. Twilio callbacks verify `X-Twilio-Signature` against the exact configured public callback URL. SES/SNS callbacks verify the provider signature, a trusted SNS topic ARN, and an HTTPS AWS SNS signing-certificate URL; certificate retrieval rejects redirects and arbitrary hosts to prevent SSRF.

## Production release checklist

1. Set `enable_waf=true` only after approving the WAF cost and monitor the rule in count mode during the first release if application traffic is not yet known.
2. Create a public Route 53 zone, request and DNS-validate the ACM certificates in the required regions, then set all six custom-domain Terraform inputs together. Confirm `https://<staff_hostname>/api/...` works before any DNS cutover; do not expose the API-origin hostname to application clients.
3. Keep `AUTH_BROWSER_COOKIE_SECURE=true`, `AUTH_BROWSER_ALLOWED_ORIGINS` exact, and all generated application secrets in Secrets Manager.
4. Configure log retention and alarms for WAF blocks, repeated 401/429 responses, failed sign-ins, unusual API request rate, and infrastructure health.
5. Before configuring Twilio live delivery, set its exact HTTPS status callback URL in both Twilio and `NOTIFICATION_TWILIO_STATUS_CALLBACK_URL`. Keep `NOTIFICATION_CHANNEL_MODE=console` until the sender identity and callback endpoint are ready.
