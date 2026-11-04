import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The data layer talks to MySQL (optional) and parses HTML on the server only.
  serverExternalPackages: ["mysql2"],
};

export default nextConfig;
