/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws',
    // Bearer token the dashboard sends to the (now key-gated) API. Baked at
    // build time — for a browser app this token is visible to anyone with the
    // page, so gate the dashboard's own access (proxy/VPN) if it must be private.
    NEXT_PUBLIC_API_KEY: process.env.NEXT_PUBLIC_API_KEY ?? '',
  },
};

export default nextConfig;
