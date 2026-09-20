/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "X-DNS-Prefetch-Control",  value: "on" },
  { key: "X-Frame-Options",         value: "DENY" },
  { key: "X-Content-Type-Options",  value: "nosniff" },
  { key: "X-XSS-Protection",        value: "1; mode=block" },
  { key: "Referrer-Policy",         value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy",      value: "camera=(), microphone=(), geolocation=(), payment=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Microsoft Clarity (heatmaps + session recordings): its tag loads from
      // www.clarity.ms, sends to *.clarity.ms, and syncs through c.bing.com.
      // Without these the browser drops it silently and the dashboard stays empty.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clarity.ms https://accounts.google.com https://connect.facebook.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
      "font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com",
      "img-src 'self' data: blob: https://*.supabase.co https://*.clarity.ms https://c.bing.com https://www.facebook.com",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://wa.me https://*.clarity.ms https://c.bing.com https://accounts.google.com https://connect.facebook.net https://www.facebook.com",
      // Google renders its account chooser in an iframe it serves itself.
      "frame-src https://accounts.google.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  // The landing page is a hand-built static document (public/landing.html).
  // beforeFiles so it wins over any app route at "/".
  async rewrites() {
    return { beforeFiles: [{ source: "/", destination: "/landing.html" }] };
  },
  // Use in-memory cache in dev to avoid the "modified during build" warnings
  // caused by Windows Defender / OneDrive / indexers racing with webpack's
  // .next/cache writes. Slightly slower cold starts; identical otherwise.
  // Production builds (NODE_ENV=production) keep the default filesystem cache.
  webpack: (config, { dev }) => {
    if (dev) config.cache = { type: "memory" };
    return config;
  },
};

export default nextConfig;
