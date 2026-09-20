import type { NextConfig } from "next";

// Phase 9: baseline security headers on every HTTP response Next.js serves (page loads, the
// /api/rooms REST route). Socket.io traffic is a separate WebSocket/polling transport on the
// same HTTP server and is unaffected by this -- its own hardening (validation, rate limiting,
// ownership checks) lives in server/socket.ts.
const securityHeaders = [
  // No third-party origin ever needs to be embedded here; this app has no ads/analytics/iframes.
  // 'unsafe-inline'/'unsafe-eval' on script-src are required by Next.js's own dev/runtime
  // bootstrap scripts -- a stricter nonce-based CSP would need a custom middleware layer, flagged
  // here as a real follow-up rather than silently left out (see PROJECT_HANDOFF.md).
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // Allow WebSocket connections to the Railway-hosted Socket.io server in production.
      // NEXT_PUBLIC_SOCKET_URL is set on Vercel at build time; falls back to 'self' for local dev.
      `connect-src 'self' ws: wss: ${process.env.NEXT_PUBLIC_SOCKET_URL || ''}`.trim(),
      "media-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Camera/microphone are used by this app's own WebRTC video call -- allow self, deny everyone else.
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(), interest-cohort=()' },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
